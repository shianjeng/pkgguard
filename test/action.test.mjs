import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bodyFor, main, markerFor, MAX_BODY, upsertComment } from '../action/comment.mjs';

const API = 'https://api.github.test';

// A tiny GitHub: the comments on pull request 7, and every request made.
function fakeGitHub({ comments = [], deny = new Set() } = {}) {
  const calls = [];
  let nextId = 1000;
  const fetchImpl = async (url, { method, body }) => {
    const { pathname, searchParams } = new URL(url);
    calls.push({ method, path: pathname, body: body ? JSON.parse(body) : undefined });
    const reply = (status, data) => ({ ok: status < 300, status, json: async () => data });
    if (deny.has(method)) return reply(403, { message: 'Resource not accessible by integration' });
    if (method === 'GET' && pathname === '/repos/o/r/issues/7/comments') {
      const page = Number(searchParams.get('page'));
      return reply(200, comments.slice((page - 1) * 100, page * 100));
    }
    if (method === 'POST' && pathname === '/repos/o/r/issues/7/comments') {
      const c = { id: nextId++, body: JSON.parse(body).body, html_url: 'https://github.test/c/new', user: { type: 'Bot' } };
      comments.push(c);
      return reply(201, c);
    }
    const m = /^\/repos\/o\/r\/issues\/comments\/(\d+)$/.exec(pathname);
    if (method === 'PATCH' && m) {
      const c = comments.find((x) => x.id === Number(m[1]));
      if (!c) return reply(404, {});
      c.body = JSON.parse(body).body;
      return reply(200, { ...c, html_url: `https://github.test/c/${c.id}` });
    }
    return reply(404, {});
  };
  return { fetchImpl, calls, comments };
}

const marker = markerFor('.');
const run = (gh, verdict, report = '### ❌ pkgguard: BLOCK\n') =>
  upsertComment({ token: 't', repo: 'o/r', number: 7, report, marker, verdict, api: API, fetchImpl: gh.fetchImpl });

test('a finding is posted once, then the same comment is updated', async () => {
  const gh = fakeGitHub({ comments: [{ id: 1, body: 'LGTM', user: { type: 'User' } }] });
  assert.equal((await run(gh, 'block')).action, 'created');
  assert.equal(gh.comments.length, 2);
  assert.ok(gh.comments[1].body.startsWith(`${marker}\n### ❌ pkgguard: BLOCK`));
  assert.equal((await run(gh, 'block')).action, 'unchanged', 'same report, no edit');
  assert.equal((await run(gh, 'warn', '### ⚠️ pkgguard: WARN\n')).action, 'updated');
  assert.equal(gh.comments.length, 2);
  assert.match(gh.comments[1].body, /WARN/);
  assert.equal(gh.calls.filter((c) => c.method === 'POST').length, 1);
});

test('a clean result posts nothing, but clears an earlier finding', async () => {
  const quiet = fakeGitHub();
  assert.equal((await run(quiet, 'ok', '### ✅ pkgguard: OK\n')).action, 'skipped');
  assert.equal(quiet.calls.filter((c) => c.method !== 'GET').length, 0);

  const earlier = fakeGitHub({ comments: [{ id: 5, body: `${marker}\nold BLOCK`, user: { type: 'Bot' } }] });
  assert.equal((await run(earlier, 'info', '### ✅ pkgguard: OK\n')).action, 'updated');
  assert.equal(earlier.comments[0].body, `${marker}\n### ✅ pkgguard: OK\n`);
});

test('the earlier comment is found on a later page, and the bot one wins over a look-alike', async () => {
  const filler = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: `comment ${i}`, user: { type: 'User' } }));
  const gh = fakeGitHub({
    comments: [...filler, { id: 200, body: `${marker}\nposted by someone`, user: { type: 'User' } }, { id: 201, body: `${marker}\nold`, user: { type: 'Bot' } }],
  });
  assert.equal((await run(gh, 'block')).action, 'updated');
  assert.ok(gh.calls.some((c) => c.method === 'PATCH' && c.path.endsWith('/201')));
  assert.equal(gh.comments.find((c) => c.id === 200).body, `${marker}\nposted by someone`);
});

test('a scan of another directory keeps its own comment', async () => {
  const gh = fakeGitHub({ comments: [{ id: 9, body: `${markerFor('backend')}\nbackend report`, user: { type: 'Bot' } }] });
  assert.equal((await run(gh, 'block')).action, 'created');
  assert.equal(gh.comments[0].body, `${markerFor('backend')}\nbackend report`);
  assert.equal(markerFor('a-->b'), '<!-- pkgguard:a- ->b -->', 'a path cannot end the HTML comment early');
});

test('a huge report is cut to fit a comment', () => {
  const body = bodyFor(marker, 'x'.repeat(MAX_BODY + 5000));
  assert.ok(body.length < 65_536);
  assert.match(body, /cut short here; the full report is in the job summary/);
});

function event(t, data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkgguard-action-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'event.json');
  fs.writeFileSync(file, JSON.stringify(data));
  const report = path.join(dir, 'report.md');
  fs.writeFileSync(report, '### ❌ pkgguard: BLOCK\n');
  return { file, report };
}

test('the action step never fails the job over a comment', async (t) => {
  const logs = [];
  const log = (line) => logs.push(line);
  const { file, report } = event(t, { pull_request: { number: 7 } });
  const env = { GITHUB_EVENT_PATH: file, GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', GITHUB_API_URL: API };

  const denied = fakeGitHub({ deny: new Set(['POST', 'PATCH']) });
  assert.equal(await main([report, 'block', '.'], env, { fetchImpl: denied.fetchImpl, log }), null);
  assert.match(logs.at(-1), /^::warning title=pkgguard::Could not comment on the pull request \(POST \/repos\/o\/r\/issues\/7\/comments answered 403\)\. .*pull-requests: write/);

  const down = async () => {
    throw new Error('getaddrinfo ENOTFOUND');
  };
  assert.equal(await main([report, 'block', '.'], env, { fetchImpl: down, log }), null);
  assert.match(logs.at(-1), /^::warning title=pkgguard::Could not comment on the pull request \(getaddrinfo ENOTFOUND\)\.$/);

  const ok = fakeGitHub();
  assert.equal((await main([report, 'block', '.'], env, { fetchImpl: ok.fetchImpl, log })).action, 'created');
  assert.match(logs.at(-1), /^pkgguard: posted a comment: https:\/\/github\.test\/c\/new$/);
});

test('outside a pull request, or without a token, nothing is called', async (t) => {
  const logs = [];
  const gh = fakeGitHub();
  const push = event(t, { ref: 'refs/heads/main' });
  await main([push.report, 'block', '.'], { GITHUB_EVENT_PATH: push.file, GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' }, { fetchImpl: gh.fetchImpl, log: (l) => logs.push(l) });
  const pr = event(t, { pull_request: { number: 7 } });
  await main([pr.report, 'block', '.'], { GITHUB_EVENT_PATH: pr.file, GITHUB_REPOSITORY: 'o/r' }, { fetchImpl: gh.fetchImpl, log: (l) => logs.push(l) });
  assert.equal(gh.calls.length, 0);
  assert.match(logs[0], /not for a pull request/);
  assert.match(logs[1], /^::warning title=pkgguard::No github-token/);
});
