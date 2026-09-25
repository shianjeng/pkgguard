import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkPackage } from '../skills/pkgguard/scripts/lib/check.mjs';
import { findInstalls } from '../skills/pkgguard/scripts/lib/parse.mjs';
import { renderResults } from '../skills/pkgguard/scripts/lib/report.mjs';
import { editDistance, lookalike } from '../skills/pkgguard/scripts/lib/similar.mjs';
import { fakeFetch, NOW } from './fixtures/fake-registry.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

async function check(command, fetchImpl = fakeFetch()) {
  const [pkg] = findInstalls(command);
  return checkPackage(pkg, { fetchImpl, now: NOW });
}
const codes = (result) => result.findings.map((f) => `${f.level}:${f.code}`);

test('an established package passes', async () => {
  const result = await check('npm i lodash');
  assert.equal(result.verdict, 'ok');
  assert.equal(result.version, '4.17.21');
  assert.equal(result.facts.downloads, 50_000_000);
});

test('a package that does not exist is blocked', async () => {
  const result = await check('npm i totally-made-up-helper');
  assert.equal(result.verdict, 'block');
  assert.deepEqual(codes(result), ['block:missing']);
});

test('a missing name close to a popular one suggests it', async () => {
  const result = await check('pip install reqeusts');
  assert.equal(result.verdict, 'block');
  assert.equal(result.suggestion, 'requests');
  assert.match(result.findings[0].text, /Did you mean "requests"/);
});

test('an unpopular lookalike is blocked', async () => {
  const result = await check('npm i expresss');
  assert.equal(result.verdict, 'block');
  assert.ok(codes(result).includes('block:lookalike'));
  assert.equal(result.suggestion, 'express');
});

test('known malware and npm security placeholders are blocked', async () => {
  const result = await check('npm i crossenv');
  assert.equal(result.verdict, 'block');
  assert.ok(codes(result).includes('block:malicious'));
  assert.ok(codes(result).includes('block:removed'));
});

test('a brand-new package with an install script is blocked', async () => {
  const result = await check('npm i shiny-new-cli');
  assert.equal(result.verdict, 'block');
  assert.ok(codes(result).includes('block:new'));
  assert.ok(codes(result).includes('warn:install-script'));
  assert.match(result.findings.find((f) => f.code === 'install-script').text, /postinstall: node setup\.js/);
});

test('a fresh release that dropped provenance and changed publisher warns', async () => {
  const result = await check('npm i chalky');
  assert.equal(result.verdict, 'warn');
  const fresh = result.findings.find((f) => f.code === 'fresh');
  assert.match(fresh.text, /12 hours ago/);
  assert.match(fresh.text, /chalky@5\.0\.0/);
  assert.match(fresh.text, /"someone-else"/);
  assert.ok(codes(result).includes('warn:provenance'));
});

test('deprecations and known vulnerabilities warn', async () => {
  assert.ok(codes(await check('npm i left-pad')).includes('warn:deprecated'));
  const old = await check('npm i lodash@4.17.20');
  assert.equal(old.version, '4.17.20');
  assert.ok(codes(old).includes('warn:vulnerable'));
});

test('a version that does not exist is blocked', async () => {
  const result = await check('npm i lodash@9.9.9');
  assert.ok(codes(result).includes('block:missing-version'));
});

test('npm ranges are checked against the version that would be installed', async () => {
  const pinned = await check('npm i "lodash@<4.17.21"');
  assert.equal(pinned.version, '4.17.20');
  assert.ok(codes(pinned).includes('warn:vulnerable'));
  assert.equal((await check('npm i lodash@^4.17.0')).version, '4.17.21');
  const impossible = await check('npm i lodash@^9');
  assert.ok(codes(impossible).includes('warn:no-match'));
});

test('PyPI versions compare the way pip does', async () => {
  const result = await check('pip install requests==2.0');
  assert.equal(result.version, '2.0.0');
  assert.ok(!codes(result).includes('block:missing-version'));
  assert.ok(codes(await check('pip install requests==2.0.1')).includes('block:missing-version'));
});

test('unpublished npm packages are blocked', async () => {
  const result = await check('npm i gone-pkg');
  assert.equal(result.verdict, 'block');
  assert.match(result.findings[0].text, /was unpublished/);
});

test('sdist-only python packages warn about build code', async () => {
  const result = await check('pip install sketchy-build');
  assert.equal(result.verdict, 'warn');
  assert.ok(codes(result).includes('warn:sdist-only'));
});

test('registry outages degrade to an unverified warning', async () => {
  const fetchImpl = fakeFetch({ 'registry.npmjs.org': () => new Response('down', { status: 503 }) });
  const result = await check('npm i lodash', fetchImpl);
  assert.equal(result.verdict, 'warn');
  assert.deepEqual(codes(result), ['warn:unverified']);
});

test('report text tells the agent what to do', async () => {
  const results = [await check('npm i lodash'), await check('npm i expresss')];
  const text = renderResults(results, { command: 'npm i lodash expresss' });
  assert.match(text, /✗ BLOCK expresss@0\.0\.0/);
  assert.match(text, /Verdict: BLOCK/);
});

test('lookalike detection', () => {
  assert.equal(editDistance('reqeusts', 'requests', 1), 1);
  assert.equal(editDistance('lodash', 'lodahs', 1), 1);
  assert.equal(editDistance('react', 'preact', 1), 1);
  assert.equal(editDistance('abcdef', 'uvwxyz', 1), 2);
  assert.equal(lookalike('npm', 'lodash'), null, 'popular packages are never lookalikes');
  assert.equal(lookalike('npm', 'cross_env').name, 'cross-env');
  assert.equal(lookalike('pypi', 'python-requests')?.name, 'requests');
  assert.equal(lookalike('npm', '@evil/lodash'), null);
  assert.equal(lookalike('npm', 'my-company-internal-tool'), null);
});

function runHook(input, env = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ['--import', path.join(ROOT, 'test/fixtures/install-fake-fetch.mjs'), path.join(ROOT, 'skills/pkgguard/scripts/hook.mjs')],
      { env: { ...process.env, ...env } },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }),
    );
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}
const bash = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });

test('hook: unrelated commands pass silently', async () => {
  assert.deepEqual(await runHook(bash('git status && ls')), { code: 0, stdout: '', stderr: '' });
  assert.equal((await runHook({ tool_name: 'Read', tool_input: { file_path: '/x' } })).stdout, '');
});

test('hook: clean installs fall through to the normal permission flow', async () => {
  const { code, stdout } = await runHook(bash('npm install lodash'));
  assert.equal(code, 0);
  assert.equal(stdout, '', 'the hook never approves on its own');
});

test('hook: blocked packages are denied with the findings as the reason', async () => {
  const { stdout } = await runHook(bash('cd web && npm i lodash expresss'));
  const out = JSON.parse(stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /expresss/);
});

test('hook: warnings ask, or follow PKGGUARD_ON_WARN', async () => {
  assert.equal(JSON.parse((await runHook(bash('npm i left-pad'))).stdout).hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(JSON.parse((await runHook(bash('npm i left-pad'), { PKGGUARD_ON_WARN: 'deny' })).stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((await runHook(bash('npm i left-pad'), { PKGGUARD_ON_WARN: 'allow' })).stdout, '');
});

test('hook: broken input never blocks', async () => {
  const { code, stdout, stderr } = await runHook('not json');
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /pkgguard hook skipped/);
});
