import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mdCode, mdText, renderMarkdown } from '../skills/pkgguard/scripts/lib/report.mjs';

const result = (name, verdict, findings = [], extra = {}) => ({
  name,
  ecosystem: 'npm',
  verdict,
  findings: findings.map(([level, text]) => ({ level, code: 'x', text })),
  facts: { exists: true, downloads: 1234, created: '2019-04-01T00:00:00Z' },
  ...extra,
});

test('text from package authors cannot become a link, image, mention or HTML in a comment', () => {
  const evil = 'Deprecated: moved, see [the fix](https://evil.test/x) ![t](https://evil.test/p.png) @maintainer <img src=x onerror=1> a|b';
  const out = mdText(evil);
  assert.doesNotMatch(out, /[^\\]\[|[^\\]\]\(|<img|https:\/\/|(^|[^\\])\|/);
  assert.match(out, /@&#8203;maintainer/);
  assert.equal(mdText('line one\n  line two'), 'line one line two');
  assert.equal(mdCode('plain'), '`plain`');
  assert.equal(mdCode('a`b'), '``a`b``');
  assert.equal(mdCode('`x'), '`` `x ``');
  assert.equal(mdCode('git+https://x|y'), '`git+https://x\\|y`', 'a pipe inside a table cell is escaped even in code');
});

test('markdown report: findings in a table, clean packages folded, verdict last', () => {
  const md = renderMarkdown(
    [
      result('lodash', 'ok'),
      result('left-pad', 'warn', [['warn', 'Deprecated: use String.prototype.padStart()']]),
      result('expresss', 'block', [['block', 'Looks like the popular package "express".'], ['info', 'No source repository listed.']], { version: '1.0.0', from: 'package.json' }),
      result('react', 'info', [['info', 'Runs code during install (postinstall), as earlier versions did.']]),
    ],
    { sources: [{ path: 'package.json', total: 4 }], version: '9.9.9', notes: [{ level: 'ok', text: 'All 120 packages pinned in package-lock.json have no malware reports in OSV.' }] },
  );
  const lines = md.split('\n');
  assert.equal(lines[0], '### ❌ pkgguard: BLOCK');
  assert.match(md, /Checked 4 packages from `package\.json`\./);
  const rows = lines.filter((l) => l.startsWith('| ❌') || l.startsWith('| ⚠️'));
  assert.equal(rows.length, 2);
  assert.match(rows[0], /^\| ❌&nbsp;BLOCK \| `expresss@1\.0\.0` <sub>npm · 1\.2k downloads\/week · since 2019 · in package\.json<\/sub> \| Looks like the popular package "express"\.<br><sub>No source repository listed\.<\/sub> \|$/);
  assert.match(rows[1], /^\| ⚠️&nbsp;WARN \| `left-pad`/, 'blocks come first');
  assert.match(md, /<details><summary>✅ 2 more with no findings<\/summary>\n\n`lodash` · `react`\n\n<\/details>/);
  assert.match(md, /- ✅ All 120 packages pinned in package-lock\.json/);
  assert.match(md, /\*\*Do not merge yet\.\*\*/);
  assert.match(md, /<sub>Checked by \[pkgguard\]\(https:\/\/github\.com\/shianjeng\/pkgguard\) 9\.9\.9\.<\/sub>\n$/);
});

test('markdown report: clean and empty runs', () => {
  const clean = renderMarkdown([result('lodash', 'ok'), result('react', 'info', [['info', 'No source repository listed.']])], { sources: [{ path: 'package.json', total: 2 }] });
  assert.match(clean, /^### ✅ pkgguard: OK\n\nChecked 2 packages from `package\.json`\.\n\n`lodash` · `react`\n\nNo suspicious dependencies found\./);
  assert.doesNotMatch(clean, /<details>|\| --- \|/);
  const nothingNew = renderMarkdown([], { sources: [{ path: 'package.json', total: 3 }], newOnly: true });
  assert.match(nothingNew, /Nothing new to check from `package\.json`: the lockfile already pins every dependency\./);
  const fresh = renderMarkdown([result('zod', 'ok')], { sources: [{ path: 'package.json', total: 9 }], newOnly: true });
  assert.match(fresh, /Checked 1 new dependency from `package\.json` \(not pinned in the lockfile yet\)\./);
});

test('scan --markdown writes the report beside the usual text, or instead of it with -', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = new URL('..', import.meta.url).pathname;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkgguard-md-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cli = (...args) =>
    spawnSync(process.execPath, ['--import', path.join(root, 'test/fixtures/install-fake-fetch.mjs'), path.join(root, 'skills/pkgguard/scripts/pkgguard.mjs'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, PKGGUARD_NO_CACHE: '1', NO_COLOR: '1' },
    });
  const file = path.join(dir, 'report.md');
  const both = cli('scan', path.join(root, 'test/fixtures/action-bad'), '--markdown', file);
  assert.equal(both.status, 2);
  assert.match(both.stdout, /^pkgguard checked 1 package/);
  assert.match(fs.readFileSync(file, 'utf8'), /^### ❌ pkgguard: BLOCK\n/);
  const only = cli('scan', path.join(root, 'test/fixtures/action-bad'), '--markdown', '-');
  assert.match(only.stdout, /^### ❌ pkgguard: BLOCK\n/);
  assert.doesNotMatch(only.stdout, /Verdict:/);
  assert.equal(cli('scan', '--json', '--markdown', '-').status, 3);
});
