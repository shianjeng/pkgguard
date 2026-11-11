#!/usr/bin/env node
// Posts the pkgguard report on a pull request, or updates the comment an
// earlier run posted, so a pull request carries one report however often it
// is pushed to. A clean result is posted only to replace an earlier finding.
// A comment that cannot be written (a pull request from a fork, a read-only
// token) never fails the job; it becomes a warning.
//   node comment.mjs <report.md> <verdict> <scan path>
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

// GitHub refuses comment bodies over 65,536 characters.
export const MAX_BODY = 60_000;

export function markerFor(scanPath) {
  return `<!-- pkgguard:${String(scanPath).replace(/--/g, '- -')} -->`;
}

export function bodyFor(marker, report) {
  const cut = report.length > MAX_BODY ? `${report.slice(0, MAX_BODY)}\n\n…cut short here; the full report is in the job summary.\n` : report;
  return `${marker}\n${cut}`;
}

export async function upsertComment({ token, repo, number, report, marker, verdict, api = 'https://api.github.com', fetchImpl = fetch }) {
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'user-agent': 'pkgguard-action',
    'x-github-api-version': '2022-11-28',
  };
  const call = async (method, url, payload) => {
    const res = await fetchImpl(url, {
      method,
      headers: payload ? { ...headers, 'content-type': 'application/json' } : headers,
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const err = new Error(`${method} ${url.slice(api.length).split('?')[0]} answered ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  };

  // Earlier reports carry the marker. One the token's own bot wrote wins over
  // a look-alike anyone could post.
  const ours = [];
  for (let page = 1; page <= 30; page++) {
    const list = await call('GET', `${api}/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
    ours.push(...list.filter((c) => typeof c.body === 'string' && c.body.startsWith(marker)));
    if (list.length < 100) break;
  }
  const existing = ours.find((c) => c.user?.type === 'Bot') ?? ours[0] ?? null;

  if (!existing && (verdict === 'ok' || verdict === 'info')) return { action: 'skipped' };
  const body = bodyFor(marker, report);
  if (existing) {
    if (existing.body === body) return { action: 'unchanged', url: existing.html_url };
    try {
      const updated = await call('PATCH', `${api}/repos/${repo}/issues/comments/${existing.id}`, { body });
      return { action: 'updated', url: updated.html_url };
    } catch (err) {
      if (err.status !== 403 && err.status !== 404) throw err;
      // Someone else's comment that only looks like ours: post a fresh one.
    }
  }
  const created = await call('POST', `${api}/repos/${repo}/issues/${number}/comments`, { body });
  return { action: 'created', url: created.html_url };
}

export async function main([file, verdict, scanPath = '.'], env = process.env, { fetchImpl = fetch, log = console.log } = {}) {
  const event = env.GITHUB_EVENT_PATH && fs.existsSync(env.GITHUB_EVENT_PATH) ? JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const number = event.pull_request?.number;
  if (!number) {
    log('pkgguard: this run is not for a pull request, so there is nothing to comment on.');
    return null;
  }
  if (!env.GITHUB_TOKEN) {
    log('::warning title=pkgguard::No github-token, so the report was not posted on the pull request.');
    return null;
  }
  try {
    const result = await upsertComment({
      token: env.GITHUB_TOKEN,
      repo: env.GITHUB_REPOSITORY,
      number,
      report: fs.readFileSync(file, 'utf8'),
      marker: markerFor(scanPath),
      verdict,
      api: env.GITHUB_API_URL || 'https://api.github.com',
      fetchImpl,
    });
    const said = { skipped: 'nothing to report and no earlier comment, so none was posted', unchanged: 'the comment is already up to date', updated: 'updated the comment', created: 'posted a comment' };
    log(`pkgguard: ${said[result.action]}${result.url ? `: ${result.url}` : ''}`);
    return result;
  } catch (err) {
    const why = err.status === 403 || err.status === 404
      ? ' The token cannot write pull request comments: give the job "permissions: pull-requests: write". Pull requests from forks only get a read-only token, so they get no comment.'
      : '';
    log(`::warning title=pkgguard::Could not comment on the pull request (${err.message}).${why}`);
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
