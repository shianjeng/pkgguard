import { verdictOf } from './check.mjs';

const LABEL = { ok: 'OK   ', info: 'OK   ', warn: 'WARN ', block: 'BLOCK' };
const MARK = { ok: '✓', info: '✓', warn: '!', block: '✗' };

function compact(n) {
  if (n === null || n === undefined) return null;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(n);
}

function headline(result) {
  const id = result.version ? `${result.name}@${result.version}` : result.name;
  const bits = [];
  const facts = result.facts;
  if (facts?.downloads !== null && facts?.downloads !== undefined && facts.exists !== false) {
    bits.push(`${compact(facts.downloads)} downloads/week`);
  }
  if (facts?.created) bits.push(`since ${facts.created.slice(0, 4)}`);
  return `${id} (${result.ecosystem})${bits.length ? ` · ${bits.join(' · ')}` : ''}`;
}

export function renderResults(results, { command = null } = {}) {
  const lines = [];
  const verdict = verdictOf(results.map((r) => ({ level: r.verdict })));
  lines.push(
    `pkgguard checked ${results.length} package${results.length === 1 ? '' : 's'}${command ? ` from: ${command}` : ''}`,
    '',
  );
  for (const r of results) {
    lines.push(`${MARK[r.verdict]} ${LABEL[r.verdict]} ${headline(r)}`);
    for (const f of r.findings) {
      if (f.level === 'info' && r.verdict !== 'ok' && r.verdict !== 'info') continue;
      lines.push(`    - ${f.text}`);
    }
  }
  lines.push('');
  if (verdict === 'block') {
    lines.push('Verdict: BLOCK. Do not install. Tell the user what pkgguard found; do not swap in a different package name without their confirmation.');
  } else if (verdict === 'warn') {
    lines.push('Verdict: WARN. Show these findings to the user and get a clear yes before installing.');
  } else {
    lines.push('Verdict: OK. Nothing suspicious found.');
  }
  return `${lines.join('\n')}\n`;
}

export function overall(results) {
  return verdictOf(results.map((r) => ({ level: r.verdict })));
}
