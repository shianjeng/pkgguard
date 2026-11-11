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

const SGR = { block: '31', warn: '33', ok: '32', info: '32', dim: '2', bold: '1' };
const paint = (on, code, text) => (on ? `\x1b[${code}m${text}\x1b[0m` : text);

// The closing line differs by reader: an agent gets instructions, a person at
// a terminal gets what happened and what they can do about it.
function verdictLine(verdict, audience, command) {
  if (audience === 'human') {
    if (verdict === 'block') return `Not installed. If you are sure, run it with PKGGUARD_OFF=1 in front${command ? `: PKGGUARD_OFF=1 ${command}` : ''}`;
    if (verdict === 'warn') return 'Worth a look before installing.';
    return 'Nothing suspicious found.';
  }
  if (verdict === 'block') return 'Verdict: BLOCK. Do not install. Tell the user what pkgguard found; do not swap in a different package name without their confirmation.';
  if (verdict === 'warn') return 'Verdict: WARN. Show these findings to the user and get a clear yes before installing.';
  return 'Verdict: OK. Nothing suspicious found.';
}

export function renderResults(results, { command = null, notes = [], audience = 'agent', color = false } = {}) {
  const lines = [];
  const verdict = overall(results, notes);
  const looked = results.filter((r) => !r.locked).length; // lockfile sweeps report their own totals
  const counted = looked ? ` checked ${looked} package${looked === 1 ? '' : 's'}` : '';
  lines.push(`pkgguard${counted}${command ? `${counted ? ' from' : ''}: ${command}` : ''}`, '');
  const quiet = (r) => r.verdict === 'ok' && r.findings.length === 0;
  const fold = results.length > FOLD_AFTER;
  const folded = fold ? results.filter(quiet) : [];
  for (const r of results) {
    if (fold && quiet(r)) continue;
    lines.push(`${paint(color, SGR[r.verdict], `${MARK[r.verdict]} ${LABEL[r.verdict]}`)} ${headline(r)}`);
    // Every finding is shown, notes included: a check that could not run must not look like a pass.
    for (const f of r.findings) lines.push(f.level === 'info' ? paint(color, SGR.dim, `    · ${f.text}`) : `    - ${f.text}`);
  }
  if (folded.length) {
    const names = folded.map((r) => r.name);
    const shown = names.slice(0, 12).join(', ');
    lines.push(`${paint(color, SGR.ok, `${MARK.ok} ${LABEL.ok}`)} ${folded.length} more with no findings: ${shown}${names.length > 12 ? `, … (+${names.length - 12})` : ''}`);
  }
  for (const note of notes) lines.push(`${paint(color, SGR[note.level], `${MARK[note.level]} ${LABEL[note.level]}`)} ${note.text}`);
  lines.push('');
  lines.push(paint(color && audience === 'human', SGR.bold, verdictLine(verdict, audience, command)));
  return `${lines.join('\n')}\n`;
}

export function overall(results, notes = []) {
  return verdictOf([...results.map((r) => ({ level: r.verdict })), ...notes]);
}

// ---- Markdown, for CI job summaries and pull request comments ----

const MD = { ok: '✅', info: '✅', warn: '⚠️', block: '❌' };
const WORD = { ok: 'OK', info: 'OK', warn: 'WARN', block: 'BLOCK' };

// Package authors write deprecation notes, install scripts and advisory
// summaries, and all of that ends up in the report. None of it may turn into a
// link, an image, a mention, HTML or a broken table on a pull request.
export function mdText(text) {
  return String(text)
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_{}[\]()#+!|~]/g, '\\$&')
    .replace(/@/g, '@&#8203;')
    .replace(/:\/\//g, ':&#47;&#47;');
}

// A code span that holds any text, backticks and table pipes included.
export function mdCode(text) {
  const t = String(text).replace(/\s*[\r\n]+\s*/g, ' ').replace(/\|/g, '\\|');
  const longest = Math.max(0, ...(t.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = /^`|`$/.test(t) ? ' ' : '';
  return `${fence}${pad}${t}${pad}${fence}`;
}

function mdHeadline(result) {
  const id = result.version && result.kind !== 'external' && result.kind !== 'computed' ? `${result.name}@${result.version}` : result.name;
  const bits = [result.ecosystem];
  const facts = result.facts;
  if (result.kind === 'external') bits.push('not from the registry');
  if (result.kind === 'computed') bits.push('name computed at run time');
  if (facts?.downloads !== null && facts?.downloads !== undefined && facts.exists !== false) bits.push(`${compact(facts.downloads)} downloads/week`);
  if (facts?.created) bits.push(`since ${facts.created.slice(0, 4)}`);
  if (result.from) bits.push(`in ${mdText(result.from)}`);
  return `${mdCode(id)} <sub>${bits.join(' · ')}</sub>`;
}

const MD_VERDICT = {
  block: '**Do not merge yet.** Each ❌ package is likely malicious, a typo of the package that was meant, or not on the registry at all. Remove it, or replace it with the package that was meant.',
  warn: '**Worth a look before merging.** Check each ⚠️ finding above.',
  ok: 'No suspicious dependencies found.',
};

export function renderMarkdown(results, { notes = [], sources = [], newOnly = false, version = null } = {}) {
  const verdict = overall(results, notes);
  const shown = verdict === 'info' ? 'ok' : verdict;
  const lines = [`### ${MD[shown]} pkgguard: ${WORD[shown]}`, ''];

  const looked = results.filter((r) => !r.locked).length;
  const from = sources.length ? ` from ${sources.map((s) => mdCode(s.path)).join(', ')}` : '';
  if (looked) lines.push(newOnly ? `Checked ${looked} new dependenc${looked === 1 ? 'y' : 'ies'}${from} (not pinned in the lockfile yet).` : `Checked ${looked} package${looked === 1 ? '' : 's'}${from}.`, '');
  else if (!results.length && !notes.length) lines.push(newOnly ? `Nothing new to check${from}: the lockfile already pins every dependency.` : `No dependencies to check${from}.`, '');

  const flagged = results.filter((r) => r.verdict === 'block' || r.verdict === 'warn');
  if (flagged.length) {
    lines.push('| | Package | Findings |', '| --- | --- | --- |');
    for (const r of flagged.sort((a, b) => (a.verdict === b.verdict ? 0 : a.verdict === 'block' ? -1 : 1))) {
      const findings = r.findings.map((f) => (f.level === 'info' ? `<sub>${mdText(f.text)}</sub>` : mdText(f.text)));
      lines.push(`| ${MD[r.verdict]}&nbsp;${WORD[r.verdict]} | ${mdHeadline(r)} | ${findings.join('<br>') || '—'} |`);
    }
    lines.push('');
  }

  const clean = results.filter((r) => r.verdict !== 'block' && r.verdict !== 'warn');
  if (clean.length) {
    const names = clean.map((r) => mdCode(r.name));
    const list = names.slice(0, 200).join(' · ') + (names.length > 200 ? ` · … (+${names.length - 200})` : '');
    if (flagged.length) lines.push(`<details><summary>✅ ${clean.length} more with no findings</summary>`, '', list, '', '</details>', '');
    else lines.push(list, '');
  }

  for (const note of notes) lines.push(`- ${MD[note.level]} ${mdText(note.text)}`);
  if (notes.length) lines.push('');

  lines.push(MD_VERDICT[shown], '');
  lines.push(`<sub>Checked by [pkgguard](https://github.com/shianjeng/pkgguard)${version ? ` ${version}` : ''}.</sub>`);
  return `${lines.join('\n')}\n`;
}
