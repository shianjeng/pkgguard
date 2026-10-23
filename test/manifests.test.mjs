import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ResultCache } from '../skills/pkgguard/scripts/lib/cache.mjs';
import { checkAll } from '../skills/pkgguard/scripts/lib/check.mjs';
import { expandInstalls, expandManifest, projectManifests, pyprojectRequirements } from '../skills/pkgguard/scripts/lib/manifests.mjs';
import { findInstalls } from '../skills/pkgguard/scripts/lib/parse.mjs';
import { renderResults } from '../skills/pkgguard/scripts/lib/report.mjs';
import { fakeFetch, NOW } from './fixtures/fake-registry.mjs';

function project(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkgguard-manifest-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

const names = (packages) => packages.map((p) => `${p.kind ?? 'registry'}:${p.name}${p.requested ? `@${p.requested}` : ''}`);

const PACKAGE_JSON = {
  dependencies: { lodash: '^4.17.0', expresss: '^0.0.0', local: 'file:../local', fork: 'user/repo#main', zodv3: 'npm:zod@^3.0.0' },
  devDependencies: { vitest: '*', ws: 'workspace:*' },
};

test('npm: only dependencies the lockfile does not pin are checked', (t) => {
  const dir = project(t, {
    'package.json': PACKAGE_JSON,
    'package-lock.json': { lockfileVersion: 3, packages: { '': {}, 'node_modules/lodash': { version: '4.17.21' }, 'node_modules/vitest': { version: '2.0.0' } } },
  });
  const { packages, lockfile } = expandManifest(path.join(dir, 'package.json'), 'npm');
  assert.equal(lockfile, true);
  assert.deepEqual(names(packages), ['registry:expresss@^0.0.0', 'external:fork (user/repo#main)', 'registry:zod@^3.0.0']);
});

test('npm: a range the locked version no longer satisfies is checked again', (t) => {
  const dir = project(t, {
    'package.json': { dependencies: { lodash: '^5.0.0' } },
    'package-lock.json': { packages: { 'node_modules/lodash': { version: '4.17.21' } } },
  });
  assert.deepEqual(names(expandManifest(path.join(dir, 'package.json'), 'npm').packages), ['registry:lodash@^5.0.0']);
});

test('npm: yarn, pnpm and bun lockfiles, found in a workspace root', (t) => {
  const yarn = project(t, {
    'yarn.lock': '"lodash@^4.17.0":\n  version "4.17.21"\n\nvitest@*:\n  version "2.0.0"\n',
    'packages/app/package.json': { dependencies: { lodash: '^4.17.0', expresss: '1' }, devDependencies: { vitest: '*' } },
  });
  assert.deepEqual(names(expandManifest(path.join(yarn, 'packages/app/package.json'), 'npm').packages), ['registry:expresss@1']);

  const pnpm = project(t, {
    'package.json': { dependencies: { lodash: '^4.17.0', expresss: '1' } },
    'pnpm-lock.yaml': "importers:\n  .:\n    dependencies:\n      lodash:\n        specifier: ^4.17.0\n        version: 4.17.21\npackages:\n  lodash@4.17.21:\n    resolution: {}\n",
  });
  assert.deepEqual(names(expandManifest(path.join(pnpm, 'package.json'), 'npm').packages), ['registry:expresss@1']);

  const bun = project(t, { 'package.json': { dependencies: { lodash: '4', expresss: '1' } }, 'bun.lock': '{ "packages": { "lodash": ["lodash@4.17.21"] } }' });
  assert.deepEqual(names(expandManifest(path.join(bun, 'package.json'), 'npm').packages), ['registry:expresss@1']);
});

test('npm: without a lockfile every dependency is checked', (t) => {
  const dir = project(t, { 'package.json': PACKAGE_JSON });
  const { packages, lockfile } = expandManifest(path.join(dir, 'package.json'), 'npm');
  assert.equal(lockfile, false);
  assert.equal(packages.length, 5);
});

test('requirements files: nesting, editables, hashes, markers and comments', (t) => {
  const dir = project(t, {
    'requirements.txt': [
      '# app',
      '-r base.txt',
      '--index-url https://pypi.org/simple',
      'requests==2.32.3 \\',
      '    --hash=sha256:abc',
      "numpy>=1.26; python_version >= '3.10'  # math",
      '-e git+https://github.com/u/r.git#egg=r',
      '-e .',
      '-c constraints.txt',
      '',
    ].join('\n'),
    'base.txt': 'reqeusts\nrequests==2.32.3\n',
  });
  const { packages } = expandManifest(path.join(dir, 'requirements.txt'), 'pypi');
  assert.deepEqual(names(packages), [
    'registry:reqeusts',
    'registry:requests@==2.32.3',
    'registry:requests@==2.32.3',
    'registry:numpy@>=1.26',
    'external:git+https://github.com/u/r.git#egg=r',
  ]);
});

test('pyproject: PEP 621 lists, dependency groups and Poetry tables', () => {
  const text = `
[project]
name = "app"
dependencies = [
  "httpx>=0.27",  # client
  'rich',
]

[project.optional-dependencies]
docs = ["mkdocs"]

[dependency-groups]
dev = ["pytest>=8", {include-group = "docs"}]

[tool.poetry.dependencies]
python = "^3.12"
django = "^5.0"
mylib = { path = "../mylib" }
forked = { git = "https://github.com/u/forked.git" }

[tool.poetry.group.test.dependencies]
hypothesis = "*"

[tool.ruff]
line-length = 100
`;
  assert.deepEqual(pyprojectRequirements(text), [
    'httpx>=0.27',
    'rich',
    'mkdocs',
    'pytest>=8',
    'django',
    'forked @ https://github.com/u/forked.git',
    'hypothesis',
  ]);
});

test('pyproject: packages pinned in uv.lock are skipped', (t) => {
  const dir = project(t, {
    'pyproject.toml': '[project]\ndependencies = ["httpx", "Rich", "reqeusts"]\n',
    'uv.lock': '[[package]]\nname = "httpx"\nversion = "0.27.0"\n\n[[package]]\nname = "rich"\nversion = "13.0"\n',
  });
  assert.deepEqual(names(expandManifest(path.join(dir, 'pyproject.toml'), 'pypi').packages), ['registry:reqeusts']);
});

test('expandInstalls follows cd, marks the source file, and says what it could not read', (t) => {
  const dir = project(t, { 'web/package.json': { dependencies: { expresss: '1' } } });
  const { packages, notes, sources } = expandInstalls(findInstalls('cd web && npm install && npm i zod'), dir);
  assert.deepEqual(
    packages.map((p) => `${p.name}${p.from ? ` from ${p.from}` : ''}`),
    ['expresss from web/package.json', 'zod'],
  );
  assert.deepEqual(notes, []);
  assert.deepEqual(sources, [{ path: 'web/package.json', total: 1, toCheck: 1, lockfile: false }]);

  const unknown = expandInstalls(findInstalls('cd "$APP" && npm install'), dir);
  assert.equal(unknown.packages.length, 0);
  assert.match(unknown.notes[0].text, /Could not tell which directory/);
});

test('expandInstalls checks at most the limit and says how many it skipped', (t) => {
  const deps = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`pkg-${i}`, '1']));
  const dir = project(t, { 'package.json': { dependencies: deps } });
  const { packages, notes } = expandInstalls(findInstalls('npm install'), dir, { limit: 5 });
  assert.equal(packages.length, 5);
  assert.equal(notes[0].level, 'warn');
  assert.match(notes[0].text, /2 more dependencies/);
});

test('projectManifests finds what scan should read', (t) => {
  const dir = project(t, { 'package.json': {}, 'pyproject.toml': '', 'requirements-dev.txt': '', 'requirements.txt': '', 'README.md': '' });
  assert.deepEqual(projectManifests(dir).map((m) => m.path), ['package.json', 'pyproject.toml', 'requirements-dev.txt', 'requirements.txt']);
});

test('the cache reuses clean results only, and expires them', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkgguard-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const packages = findInstalls('npm i lodash expresss');

  const first = fakeFetch();
  await checkAll(packages, { fetchImpl: first, now: NOW, registries: new Map(), cache: new ResultCache({ dir, now: NOW }) });
  assert.ok(first.calls.length > 0);

  const second = fakeFetch();
  const results = await checkAll(packages, { fetchImpl: second, now: NOW, registries: new Map(), cache: new ResultCache({ dir, now: NOW + 60_000 }) });
  assert.equal(results[0].cached, true, 'lodash came from the cache');
  assert.ok(second.calls.every((url) => url.includes('expresss') || url.includes('osv')), 'only the flagged package was fetched again');
  assert.equal(results[1].verdict, 'block');

  const later = new ResultCache({ dir, now: NOW + 7 * 3_600_000 });
  assert.equal(later.get(packages[0]), null, 'entries expire after six hours');
});

test('long result lists fold the clean packages into one line', () => {
  const clean = Array.from({ length: 10 }, (_, i) => ({ name: `pkg-${i}`, ecosystem: 'npm', verdict: 'ok', findings: [] }));
  const flagged = { name: 'expresss', ecosystem: 'npm', verdict: 'block', findings: [{ level: 'block', text: 'typosquat' }] };
  const text = renderResults([...clean, flagged], { notes: [{ level: 'warn', text: '3 more dependencies were not checked.' }] });
  assert.match(text, /✗ BLOCK expresss/);
  assert.match(text, /✓ OK {4}10 more with no findings: pkg-0, pkg-1/);
  assert.match(text, /! WARN {2}3 more dependencies were not checked\./);
  assert.match(text, /Verdict: BLOCK/);
});
