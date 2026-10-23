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
  if (result.kind === 'external') return `${result.name} (${result.ecosystem}, not from the registry)`;
  if (result.kind === 'computed') return `${result.name} (${result.ecosystem}, name computed at run time)`;
  const id = result.version ? `${result.name}@${result.version}` : result.name;
  const bits = [];
  const facts = result.facts;
  if (facts?.downloads !== null && facts?.downloads !== undefined && facts.exists !== false) {
    bits.push(`${compact(facts.downloads)} downloads/week`);
  }
  if (facts?.created) bits.push(`since ${facts.created.slice(0, 4)}`);
  if (result.from) bits.push(`from ${result.from}`);
  return `${id} (${result.ecosystem})${bits.length ? ` · ${bits.join(' · ')}` : ''}`;
}

// Results with nothing to say are folded into one line once a list gets long
// (a whole package.json), so the findings that matter stay visible.
const FOLD_AFTER = 8;

export function renderResults(results, { command = null, notes = [] } = {}) {
  const lines = [];
  const verdict = overall(results, notes);
  lines.push(
    `pkgguard checked ${results.length} package${results.length === 1 ? '' : 's'}${command ? ` from: ${command}` : ''}`,
    '',
  );
  const quiet = (r) => r.verdict === 'ok' && r.findings.length === 0;
  const fold = results.length > FOLD_AFTER;
  const folded = fold ? results.filter(quiet) : [];
  for (const r of results) {
    if (fold && quiet(r)) continue;
    lines.push(`${MARK[r.verdict]} ${LABEL[r.verdict]} ${headline(r)}`);
    // Every finding is shown, notes included: a check that could not run must not look like a pass.
    for (const f of r.findings) lines.push(`    ${f.level === 'info' ? '·' : '-'} ${f.text}`);
  }
  if (folded.length) {
    const names = folded.map((r) => r.name);
    const shown = names.slice(0, 12).join(', ');
    lines.push(`${MARK.ok} ${LABEL.ok} ${folded.length} more with no findings: ${shown}${names.length > 12 ? `, … (+${names.length - 12})` : ''}`);
  }
  for (const note of notes) lines.push(`${MARK[note.level]} ${LABEL[note.level]} ${note.text}`);
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

export function overall(results, notes = []) {
  return verdictOf([...results.map((r) => ({ level: r.verdict })), ...notes]);
}
