import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { context, installApp, stableNode, TARGETS } from '../skills/pkgguard/scripts/lib/setup.mjs';
import { rcBlock, shellScript, WRAPPED, withoutRcBlock, withRcBlock } from '../skills/pkgguard/scripts/lib/shell.mjs';
import { VERSION } from '../skills/pkgguard/scripts/lib/version.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FAKE_FETCH = path.join(ROOT, 'test/fixtures/install-fake-fetch.mjs');
const target = (id) => TARGETS.find((t) => t.id === id);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function sandbox(t, files = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pkgguard-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(home, name)), { recursive: true });
    fs.writeFileSync(path.join(home, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return home;
}

// A stand-in for the claude CLI that remembers what it was asked to do.
function fakeClaude({ marketplace = false } = {}) {
  const calls = [];
  let installed = false;
  let listed = marketplace;
  const run = (cmd, args) => {
    calls.push(`${cmd} ${args.join(' ')}`);
    const line = args.join(' ');
    if (line === 'plugin list') return { status: 0, stdout: installed ? 'pkgguard@pkgguard\n' : 'No plugins installed.\n', stderr: '' };
    if (line === 'plugin marketplace list') return { status: 0, stdout: `claude-plugins-official\n${listed ? 'pkgguard\n' : ''}`, stderr: '' };
    if (line === 'plugin marketplace add shianjeng/pkgguard') listed = true;
    if (line === 'plugin marketplace remove pkgguard') listed = false;
    if (line === 'plugin install pkgguard@pkgguard') installed = true;
    if (line === 'plugin uninstall pkgguard@pkgguard') installed = false;
    return { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls, marketplaceListed: () => listed };
}

function ctxFor(home, { shell = '/bin/zsh', withClaude = true, run } = {}) {
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  if (withClaude) fs.writeFileSync(path.join(bin, 'claude'), '');
  return context({ home, env: { HOME: home, SHELL: shell, PATH: bin }, node: process.execPath, run });
}

test('the version constant matches package.json', () => {
  assert.equal(VERSION, readJson(path.join(ROOT, 'package.json')).version);
  assert.equal(VERSION, readJson(path.join(ROOT, '.claude-plugin/plugin.json')).version);
});

test('init sets up every agent and the shell without touching what was already there', (t) => {
  const home = sandbox(t, {
    '.cursor/hooks.json': { version: 1, hooks: { beforeShellExecution: [{ command: './hooks/mine.sh' }] } },
    '.gemini/settings.json': { theme: 'dark', hooks: { BeforeTool: [{ matcher: 'write_file', hooks: [{ type: 'command', command: './lint.sh' }] }] } },
    '.codex/config.toml': 'model = "gpt"\n',
    '.zshrc': 'export EDITOR=vim\n',
  });
  const claude = fakeClaude();
  const ctx = ctxFor(home, { run: claude.run });
  installApp(ctx);
  for (const t of TARGETS) assert.equal(t.present(ctx), true, t.id);
  for (const t of TARGETS) assert.equal(t.install(ctx).changed, true, t.id);

  const cursor = readJson(path.join(home, '.cursor/hooks.json'));
  assert.equal(cursor.hooks.beforeShellExecution[0].command, './hooks/mine.sh');
  assert.match(cursor.hooks.beforeShellExecution[1].command, /hook\.mjs" --agent cursor$/);
  assert.ok(cursor.hooks.beforeShellExecution[1].matcher);

  const gemini = readJson(path.join(home, '.gemini/settings.json'));
  assert.equal(gemini.theme, 'dark');
  assert.deepEqual(gemini.hooks.BeforeTool.map((g) => g.matcher), ['write_file', 'run_shell_command']);

  const codex = readJson(path.join(home, '.codex/hooks.json'));
  assert.equal(codex.hooks.PreToolUse[0].matcher, '^Bash$');
  assert.match(codex.hooks.PreToolUse[0].hooks[0].command, /--agent codex$/);

  const zshrc = fs.readFileSync(path.join(home, '.zshrc'), 'utf8');
  assert.match(zshrc, /^export EDITOR=vim\n\n# >>> pkgguard >>>\n/);
  assert.ok(fs.existsSync(path.join(home, '.pkgguard/shell.zsh')));

  assert.deepEqual(claude.calls, ['claude plugin list', 'claude plugin marketplace list', 'claude plugin marketplace add shianjeng/pkgguard', 'claude plugin install pkgguard@pkgguard']);
  for (const file of ['.cursor/hooks.json', '.gemini/settings.json', '.zshrc']) {
    assert.ok(fs.existsSync(path.join(home, `${file}.pkgguard-backup`)), `${file} backed up`);
  }
  assert.ok(!fs.existsSync(path.join(home, '.codex/hooks.json.pkgguard-backup')), 'nothing to back up for a new file');
  assert.equal(fs.readFileSync(path.join(home, '.pkgguard/app/VERSION'), 'utf8').trim(), VERSION);
  for (const t of TARGETS) assert.equal(t.configured(ctx), true, t.id);
});

test('init twice changes nothing the second time', (t) => {
  const home = sandbox(t, { '.cursor/.keep': '', '.codex/.keep': '', '.gemini/.keep': '', '.zshrc': '' });
  const ctx = ctxFor(home, { run: fakeClaude().run });
  installApp(ctx);
  for (const t of TARGETS) t.install(ctx);
  for (const t of TARGETS) assert.equal(t.install(ctx).changed, false, t.id);
  assert.equal(readJson(path.join(home, '.cursor/hooks.json')).hooks.beforeShellExecution.length, 1);
  assert.equal(fs.readFileSync(path.join(home, '.zshrc'), 'utf8').split('>>> pkgguard >>>').length, 2);
});

test('uninstall restores the original files and removes the ones init created', (t) => {
  const files = {
    '.cursor/hooks.json': { version: 1, hooks: { beforeShellExecution: [{ command: './hooks/mine.sh' }] } },
    '.gemini/settings.json': { theme: 'dark' },
    '.codex/.keep': '',
    '.zshrc': 'export EDITOR=vim\n',
  };
  const home = sandbox(t, files);
  const ctx = ctxFor(home, { run: fakeClaude().run });
  installApp(ctx);
  for (const t of TARGETS) t.install(ctx);
  for (const t of TARGETS) assert.equal(t.uninstall(ctx).changed, true, t.id);
  assert.deepEqual(readJson(path.join(home, '.cursor/hooks.json')), files['.cursor/hooks.json']);
  for (const file of ['.cursor/hooks.json', '.gemini/settings.json', '.zshrc']) {
    assert.ok(!fs.existsSync(path.join(home, `${file}.pkgguard-backup`)), `${file}: restored, so its backup is gone`);
  }
  assert.deepEqual(readJson(path.join(home, '.gemini/settings.json')), files['.gemini/settings.json']);
  assert.equal(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), files['.zshrc']);
  assert.ok(!fs.existsSync(path.join(home, '.codex/hooks.json')), 'created by init, empty again, so removed');
  for (const t of TARGETS) assert.equal(t.configured(ctx), false, t.id);
});

test('a config that is not plain JSON is left alone', (t) => {
  const text = '{\n  // my settings\n  "theme": "dark"\n}\n';
  const home = sandbox(t, { '.gemini/settings.json': text });
  const result = target('gemini').install(ctxFor(home));
  assert.match(result.error, /is not plain JSON/);
  assert.equal(fs.readFileSync(path.join(home, '.gemini/settings.json'), 'utf8'), text);
});

test('without the claude CLI, init says how to install the plugin by hand', (t) => {
  const home = sandbox(t, { '.claude/.keep': '' });
  const result = target('claude').install(ctxFor(home, { withClaude: false }));
  assert.match(result.manual, /\/plugin marketplace add shianjeng\/pkgguard/);
});

test('dry runs write nothing', (t) => {
  const home = sandbox(t, { '.cursor/.keep': '', '.zshrc': 'x\n' });
  const ctx = { ...ctxFor(home), dryRun: true };
  assert.equal(target('cursor').install(ctx).changed, true);
  assert.equal(target('shell').install(ctx).changed, true);
  assert.ok(!fs.existsSync(path.join(home, '.cursor/hooks.json')));
  assert.equal(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), 'x\n');
});

test('the node written into hooks is the stable name on PATH when it is the same file', (t) => {
  const home = sandbox(t);
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  assert.equal(stableNode(process.execPath, { PATH: bin }), path.join(bin, 'node'));
  assert.equal(stableNode(process.execPath, { PATH: '' }), process.execPath);
});

test('rc blocks go in once and come out cleanly', () => {
  const block = rcBlock('/h/.pkgguard/shell.zsh');
  assert.equal(withRcBlock('', block), block);
  const once = withRcBlock('export A=1\n', block);
  assert.equal(withRcBlock(once, block), once);
  assert.equal(withoutRcBlock(once), 'export A=1\n');
  assert.equal(withoutRcBlock(`${once}export B=2\n`), 'export A=1\nexport B=2\n');
});

// ---- the hook, in every agent's format ----

function runHook(agent, input, env = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ['--import', FAKE_FETCH, path.join(ROOT, 'skills/pkgguard/scripts/hook.mjs'), '--agent', agent],
      { env: { ...process.env, PKGGUARD_NO_CACHE: '1', ...env } },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, out: stdout ? JSON.parse(stdout) : null, stderr }),
    );
    child.stdin.end(JSON.stringify(input));
  });
}

test('every agent gets a deny it understands for a typosquat', async () => {
  const command = 'npm i expresss';
  const claude = await runHook('claude', { tool_name: 'Bash', tool_input: { command } });
  assert.equal(claude.out.hookSpecificOutput.permissionDecision, 'deny');
  const codex = await runHook('codex', { tool_name: 'Bash', tool_input: { command } });
  assert.equal(codex.out.hookSpecificOutput.permissionDecision, 'deny');
  const gemini = await runHook('gemini', { tool_name: 'run_shell_command', tool_input: { command } });
  assert.equal(gemini.out.decision, 'deny');
  assert.match(gemini.out.reason, /expresss/);
  assert.match(gemini.out.systemMessage, /pkgguard blocked this install: expresss/);
  const cursor = await runHook('cursor', { command, cwd: os.tmpdir() });
  assert.equal(cursor.out.permission, 'deny');
  assert.match(cursor.out.user_message, /expresss/);
  assert.match(cursor.out.agent_message, /Verdict: BLOCK/);
});

test('a warning asks where the agent can ask, and denies where an ask would be ignored', async () => {
  const command = 'npm i left-pad';
  assert.equal((await runHook('claude', { tool_name: 'Bash', tool_input: { command } })).out.hookSpecificOutput.permissionDecision, 'ask');
  assert.equal((await runHook('cursor', { command })).out.permission, 'ask');
  const codex = await runHook('codex', { tool_name: 'Bash', tool_input: { command } });
  assert.equal(codex.out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(codex.out.hookSpecificOutput.permissionDecisionReason, /cannot ask the user to confirm/);
  assert.equal((await runHook('gemini', { tool_name: 'run_shell_command', tool_input: { command } })).out.decision, 'deny');
  assert.equal((await runHook('gemini', { tool_name: 'run_shell_command', tool_input: { command } }, { PKGGUARD_ON_WARN: 'allow' })).out, null);
});

test('other tools and clean commands get no answer at all', async () => {
  assert.equal((await runHook('gemini', { tool_name: 'write_file', tool_input: { file_path: 'x' } })).out, null);
  assert.equal((await runHook('cursor', { command: 'git status' })).out, null);
  assert.equal((await runHook('codex', { tool_name: 'Bash', tool_input: { command: 'npm i lodash' } })).out, null);
});

// ---- the shell guard ----

function runGuard(args, env = {}) {
  const r = spawnSync(process.execPath, ['--import', FAKE_FETCH, path.join(ROOT, 'skills/pkgguard/scripts/pkgguard.mjs'), 'guard', ...args], {
    encoding: 'utf8',
    env: { ...process.env, PKGGUARD_NO_CACHE: '1', NO_COLOR: '1', ...env },
  });
  return { code: r.status, stderr: r.stderr };
}

test('guard: exit codes the shell functions act on', (t) => {
  const dir = sandbox(t);
  const yes = path.join(dir, 'yes');
  const no = path.join(dir, 'no');
  fs.writeFileSync(yes, 'y\n');
  fs.writeFileSync(no, '\n');
  assert.equal(runGuard(['npm', 'run', 'build']).code, 0);
  const ok = runGuard(['npm', 'install', 'lodash']);
  assert.equal(ok.code, 0);
  assert.equal(ok.stderr, 'pkgguard ✓ lodash\n');
  const blocked = runGuard(['npm', 'install', 'expresss']);
  assert.equal(blocked.code, 2);
  assert.match(blocked.stderr, /Not installed\. If you are sure, run it with PKGGUARD_OFF=1 in front: PKGGUARD_OFF=1 npm install expresss/);
  assert.equal(runGuard(['npm', 'install', 'left-pad'], { PKGGUARD_TTY: yes }).code, 0);
  assert.equal(runGuard(['npm', 'install', 'left-pad'], { PKGGUARD_TTY: no }).code, 3, 'the default answer is no');
  assert.equal(runGuard(['npm', 'install', 'left-pad'], { PKGGUARD_TTY: path.join(dir, 'missing') }).code, 3, 'no terminal, no install');
  assert.equal(runGuard(['npm', 'install', 'left-pad'], { PKGGUARD_TTY: '/dev/null' }).code, 3, 'end of input is not an answer');
  assert.equal(runGuard(['npm', 'install', 'left-pad'], { PKGGUARD_ON_WARN: 'allow' }).code, 0);
  assert.equal(runGuard(['npm', 'install', 'lodash'], { PKGGUARD_QUIET: '1' }).stderr, '');
});

test('guard: words with spaces and quotes reach the parser intact', () => {
  assert.equal(runGuard(['pip', 'install', 'reqeusts', "it's"]).code, 2);
});

// Runs the generated script in a real shell, with a fake package manager that
// says when it actually ran.
function shellCase(t, shell, command, env = {}) {
  const dir = sandbox(t);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  for (const tool of ['npm', 'pip']) fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\necho "REAL ${tool} $*"\n`, { mode: 0o755 });
  const node = path.join(bin, 'node-with-fake-registry');
  fs.writeFileSync(node, `#!/bin/sh\nexec "${process.execPath}" --import "${FAKE_FETCH}" "$@"\n`, { mode: 0o755 });
  const script = path.join(dir, `pkgguard.${shell}`);
  fs.writeFileSync(script, shellScript(shell, { node, cli: path.join(ROOT, 'skills/pkgguard/scripts/pkgguard.mjs') }));
  const r = spawnSync(shell, ['-c', `. "${script}"; ${command}`], {
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, PKGGUARD_NO_CACHE: '1', NO_COLOR: '1', ...env },
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

for (const shell of ['bash', 'zsh']) {
  const available = spawnSync('sh', ['-c', `command -v ${shell}`]).status === 0;
  test(`${shell}: the wrapped package managers are checked and still run`, { skip: !available && `${shell} not installed` }, (t) => {
    const blocked = shellCase(t, shell, 'npm install expresss');
    assert.equal(blocked.code, 1);
    assert.doesNotMatch(blocked.out, /REAL npm/);
    const clean = shellCase(t, shell, 'npm install lodash');
    assert.equal(clean.code, 0);
    // stdout and stderr are read separately, so only their contents can be compared, not the order
    assert.match(clean.out, /pkgguard ✓ lodash/);
    assert.match(clean.out, /REAL npm install lodash/);
    assert.match(shellCase(t, shell, 'npm run build').out, /^REAL npm run build\n$/);
    assert.match(shellCase(t, shell, 'PKGGUARD_OFF=1 npm install expresss').out, /REAL npm install expresss/);
    assert.match(shellCase(t, shell, 'pip install reqeusts').out, /BLOCK reqeusts/);
  });
}

test('the shell functions fall back to the real command when pkgguard is gone', (t) => {
  const dir = sandbox(t);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\necho "REAL npm $*"\n', { mode: 0o755 });
  const script = path.join(dir, 'pkgguard.bash');
  fs.writeFileSync(script, shellScript('bash', { node: process.execPath, cli: path.join(dir, 'deleted/pkgguard.mjs') }));
  const r = spawnSync('bash', ['-c', `. "${script}"; npm install lodash`], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin` } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /REAL npm install lodash/);
  assert.match(r.stderr, /pkgguard: not found at .*run pkgguard init again/);
});

test('generated scripts wrap every package manager, in each shell syntax', () => {
  const opts = { node: '/n/node', cli: "/it's/pkgguard.mjs" };
  const posix = shellScript('zsh', opts);
  const fish = shellScript('fish', opts);
  for (const tool of WRAPPED) {
    assert.ok(posix.includes(`function ${tool} { __pkgguard_run ${tool} "$@"; }`), tool);
    assert.ok(fish.includes(`function ${tool} --wraps ${tool}\n    __pkgguard_run ${tool} $argv\nend`), tool);
  }
  assert.ok(posix.includes(`__pkgguard_cli='/it'\\''s/pkgguard.mjs'`), 'POSIX single-quote escaping');
  assert.ok(fish.includes(`set -g __pkgguard_cli '/it\\'s/pkgguard.mjs'`), 'fish single-quote escaping');
});

test('init does not take end of input for a yes', (t) => {
  const home = sandbox(t, { '.cursor/.keep': '' });
  const r = spawnSync(process.execPath, [path.join(ROOT, 'skills/pkgguard/scripts/pkgguard.mjs'), 'init'], {
    encoding: 'utf8',
    env: { HOME: home, SHELL: '/bin/zsh', PATH: '/usr/bin:/bin', PKGGUARD_TTY: '/dev/null' },
  });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /no terminal to confirm on; run again with --yes/);
  assert.ok(!fs.existsSync(path.join(home, '.cursor/hooks.json')));
  assert.ok(!fs.existsSync(path.join(home, '.pkgguard')));
});

test('uninstall gives back the exact bytes, and init keeps the file formatting', (t) => {
  // four-space indent and no final newline, as some editors write it
  const original = '{\n    "theme": "dark",\n    "ui": {\n        "compact": true\n    }\n}';
  const home = sandbox(t, { '.gemini/settings.json': original });
  const ctx = ctxFor(home);
  installApp(ctx);
  target('gemini').install(ctx);
  const installed = fs.readFileSync(path.join(home, '.gemini/settings.json'), 'utf8');
  assert.ok(installed.startsWith('{\n    "theme": "dark",'), 'same indent as before');
  assert.ok(!installed.endsWith('\n'), 'no final newline added');
  target('gemini').uninstall(ctx);
  assert.equal(fs.readFileSync(path.join(home, '.gemini/settings.json'), 'utf8'), original);
  assert.ok(!fs.existsSync(path.join(home, '.gemini/settings.json.pkgguard-backup')));
});

test('a file edited after init keeps the edits, and its backup stays', (t) => {
  const home = sandbox(t, { '.zshrc': 'export A=1\n' });
  const ctx = ctxFor(home);
  installApp(ctx);
  target('shell').install(ctx);
  fs.appendFileSync(path.join(home, '.zshrc'), 'export B=2\n');
  target('shell').uninstall(ctx);
  const rc = fs.readFileSync(path.join(home, '.zshrc'), 'utf8');
  assert.doesNotMatch(rc, /pkgguard/);
  assert.match(rc, /export A=1\n/);
  assert.match(rc, /export B=2\n/);
  assert.ok(fs.existsSync(path.join(home, '.zshrc.pkgguard-backup')));
});

test('uninstall removes the Claude marketplace only if init added it', (t) => {
  const home = sandbox(t, { '.claude/.keep': '' });
  const added = fakeClaude();
  const ctx = ctxFor(home, { run: added.run });
  target('claude').install(ctx);
  assert.equal(added.marketplaceListed(), true);
  target('claude').uninstall(ctx);
  assert.equal(added.marketplaceListed(), false, 'init added it, so it goes');

  const home2 = sandbox(t, { '.claude/.keep': '' });
  const theirs = fakeClaude({ marketplace: true });
  const ctx2 = ctxFor(home2, { run: theirs.run });
  target('claude').install(ctx2);
  target('claude').uninstall(ctx2);
  assert.equal(theirs.marketplaceListed(), true, 'the user had it before, so it stays');
  assert.ok(!theirs.calls.includes('claude plugin marketplace remove pkgguard'));
});
