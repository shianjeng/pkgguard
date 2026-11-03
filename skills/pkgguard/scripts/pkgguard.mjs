#!/usr/bin/env node
// Checks npm and PyPI packages before they are installed.
//   pkgguard npm:lodash pypi:requests
//   pkgguard --cmd "npm install lodash left-pad"
//   pkgguard scan [dir]
// Exit codes: 0 ok, 1 warn, 2 block, 3 usage or internal error.
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openCache } from './lib/cache.mjs';
import { checkAll } from './lib/check.mjs';
import { sweepLockfiles, sweepReport } from './lib/lockfiles.mjs';
import { expandInstalls, projectManifests } from './lib/manifests.mjs';
import { findInstalls, parseNpmSpec, parsePySpec } from './lib/parse.mjs';
import { overall, renderResults } from './lib/report.mjs';
import { askTerminal, guard } from './lib/guard.mjs';
import { context, installApp, installedVersion, selfTest, TARGETS } from './lib/setup.mjs';
import { SHELLS, shellScript } from './lib/shell.mjs';
import { VERSION } from './lib/version.mjs';

const USAGE = `Usage:
  pkgguard init [--yes] [--dry-run] [--only claude,cursor,codex,gemini,shell]
  pkgguard doctor
  pkgguard uninstall [--yes]
  pkgguard npm:<package>[@version] pypi:<package>[==version] ...
  pkgguard --cmd "<install command>"
  pkgguard scan [dir] [--new-only]

  init        set pkgguard up in every coding agent on this machine and in
              your shell, so npm, pip and friends you type are checked too
  doctor      check that every place init set up still blocks a typosquat
  uninstall   take it all out again
  --cmd       check what a shell command would install, including what a bare
              "npm install" or "pip install -r file" reads from its manifest
  scan        check every direct dependency in package.json, pyproject.toml
              and requirements*.txt in dir (default: the current directory)
  --new-only  with scan: only dependencies the lockfile does not pin yet
  --no-lockfile
              skip checking every package the lockfile pins (direct and
              transitive) against OSV malware reports
  --fail-on   warn (default) or block: the lowest verdict that exits non-zero
  --json      print machine-readable results
  --no-cache  re-check packages that came back clean in the last 6 hours

Exit codes: 0 ok, 1 warn, 2 block, 3 usage error`;

const EXIT = { ok: 0, info: 0, warn: 1, block: 2 };

function parseTarget(arg) {
  const m = /^(npm|pypi|pip):(.+)$/i.exec(arg);
  if (!m) return null;
  return m[1].toLowerCase() === 'npm' ? parseNpmSpec(m[2]) : parsePySpec(m[2]);
}

function option(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
  args.splice(i, 2);
  return value;
}

function flag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

// A path relative to where pkgguard runs when it is below it, else with ~ for home.
function display(file) {
  const relative = path.relative(process.cwd(), file);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
  const home = os.homedir();
  return file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}

function nothingToCheck(sources) {
  if (!sources.length) return 'pkgguard: no package installs found in that command.';
  const list = sources.map((s) => `${s.path} (${s.total} dependenc${s.total === 1 ? 'y' : 'ies'})`).join(', ');
  return `pkgguard: nothing new to check; every dependency in ${list} is already pinned in the lockfile.`;
}

// ---- init, doctor, uninstall ----

const say = (line = '') => process.stdout.write(`${line}\n`);

function confirm(question, yes) {
  if (yes) return true;
  const answer = askTerminal(question, { stderr: process.stdout, ttyPath: process.env.PKGGUARD_TTY || '/dev/tty' });
  if (answer === null) throw new Error('no terminal to confirm on; run again with --yes');
  return answer === '' || /^y(es)?$/i.test(answer);
}

function pickTargets(args) {
  const only = option(args, '--only')?.split(',');
  const unknown = only?.filter((id) => !TARGETS.some((t) => t.id === id));
  if (unknown?.length) throw new Error(`unknown target ${unknown.join(', ')}; choose from ${TARGETS.map((t) => t.id).join(', ')}`);
  return TARGETS.filter((t) => !only || only.includes(t.id));
}

function outcome(result) {
  if (result.error) return `✗ ${result.error}`;
  if (result.manual) return `! ${result.manual}`;
  return result.changed ? '✓ set up' : '· already set up';
}

async function initCommand(args) {
  const yes = flag(args, '--yes') || flag(args, '-y');
  const dryRun = flag(args, '--dry-run');
  const targets = pickTargets(args);
  const ctx = context({ dryRun });
  const present = targets.filter((t) => t.present(ctx));
  const absent = targets.filter((t) => !t.present(ctx));

  say(`pkgguard ${VERSION} init`);
  say();
  if (!present.length) {
    say('Found no coding agent and no supported shell (zsh, bash, fish) to set up.');
    return 1;
  }
  say('Will set up:');
  for (const t of present) say(`  ${t.label.padEnd(12)} ${t.where(ctx)}`);
  if (absent.length) say(`Not found here: ${absent.map((t) => t.label).join(', ')}`);
  say();
  say(`The checking code goes to ${ctx.show(ctx.loc.app)}. Each file is backed up as <file>.pkgguard-backup before its first change.`);
  if (dryRun) return 0;
  if (!confirm('Continue? [Y/n] ', yes)) return 1;
  say();

  installApp(ctx);
  const next = [];
  for (const t of present) {
    let result;
    try {
      result = t.install(ctx);
    } catch (err) {
      result = { error: err.message };
    }
    say(`  ${t.label.padEnd(12)} ${outcome(result).replace(/\n/g, '\n               ')}`);
    if (result.changed && t.next) next.push(t.next);
  }
  say();
  for (const line of next) say(`Next: ${line}`);
  say('Then check it with: pkgguard doctor');
  return 0;
}

async function doctorCommand(args) {
  const targets = pickTargets(args);
  const ctx = context();
  const installed = installedVersion(ctx);
  say(`pkgguard ${VERSION} doctor`);
  say(installed ? `Checking code: ${ctx.show(ctx.loc.app)} (${installed})${installed === VERSION ? '' : ` — older than this pkgguard; run pkgguard init to update it`}` : `Checking code: not installed at ${ctx.show(ctx.loc.app)}; run pkgguard init`);
  if (!fs.existsSync(ctx.node)) say(`! Node.js at ${ctx.node} is gone; run pkgguard init again`);
  say();
  let healthy = Boolean(installed);
  for (const t of targets) {
    const label = `  ${t.label.padEnd(12)}`;
    if (!t.present(ctx)) {
      say(`${label} – not on this machine`);
      continue;
    }
    const configured = t.configured(ctx);
    if (!configured) {
      say(`${label} – not set up (pkgguard init --only ${t.id})`);
      continue;
    }
    let test;
    if (t.id === 'shell') {
      const r = spawnGuard(ctx);
      test = r.status === 2 ? { ok: true } : { ok: false, detail: r.status === 0 ? 'a typosquat was let through (offline?)' : r.stderr.trim().split('\n').pop() };
    } else {
      test = installed ? selfTest(ctx, t) : { ok: false, detail: 'checking code not installed' };
    }
    if (!test.ok) healthy = false;
    say(`${label} ${test.ok ? '✓ blocks a typosquat (npm install expresss)' : `✗ ${test.detail}`}`);
  }
  return healthy ? 0 : 1;
}

function spawnGuard(ctx) {
  const r = spawnSync(ctx.node, [ctx.loc.cli, 'guard', 'npm', 'install', 'expresss'], {
    encoding: 'utf8',
    env: { ...ctx.env, PKGGUARD_NO_CACHE: '1', PKGGUARD_TTY: '/dev/null', NO_COLOR: '1' },
    timeout: 60_000,
  });
  return { status: r.status ?? 1, stderr: r.stderr ?? '' };
}

async function uninstallCommand(args) {
  const yes = flag(args, '--yes') || flag(args, '-y');
  const targets = pickTargets(args);
  const ctx = context();
  say(`pkgguard ${VERSION} uninstall`);
  if (!confirm('Remove pkgguard from every agent and your shell? [Y/n] ', yes)) return 1;
  for (const t of targets) {
    let result;
    try {
      result = t.uninstall(ctx);
    } catch (err) {
      result = { error: err.message };
    }
    say(`  ${t.label.padEnd(12)} ${result.error ? `✗ ${result.error}` : result.changed ? '✓ removed' : '· nothing to remove'}`);
  }
  if (targets.length === TARGETS.length) {
    fs.rmSync(ctx.loc.base, { recursive: true, force: true });
    say(`  Removed ${ctx.show(ctx.loc.base)}. Backups (*.pkgguard-backup) were left where they are.`);
  }
  return 0;
}

const SUBCOMMANDS = {
  init: initCommand,
  doctor: doctorCommand,
  uninstall: uninstallCommand,
  // Called by the shell functions with the command as typed; none of its words are pkgguard's.
  guard: (args) => guard(args),
  'shell-init': (args) => {
    const shell = args[0] ?? path.basename(process.env.SHELL ?? '');
    if (!SHELLS.includes(shell)) throw new Error(`shell-init takes ${SHELLS.join(', ')}`);
    process.stdout.write(shellScript(shell, { node: process.execPath, cli: fileURLToPath(import.meta.url) }));
    return 0;
  },
};

async function main(argv) {
  const args = [...argv];
  if (SUBCOMMANDS[args[0]]) return SUBCOMMANDS[args[0]](args.slice(1));
  if (!args.length || args.includes('-h') || args.includes('--help')) {
    process.stdout.write(`${USAGE}\n`);
    return args.length ? 0 : 3;
  }
  const json = flag(args, '--json');
  const noCache = flag(args, '--no-cache');
  const newOnly = flag(args, '--new-only');
  const noLockfile = flag(args, '--no-lockfile');
  const failOn = option(args, '--fail-on') ?? 'warn';
  if (!['warn', 'block'].includes(failOn)) throw new Error('--fail-on takes "warn" or "block"');

  let packages;
  let notes = [];
  let sources = [];
  let lockfiles = [];
  let command = null;
  let cwd = process.cwd();

  if (args[0] === 'scan') {
    if (args.length > 2) throw new Error(`unexpected argument "${args[2]}"`);
    cwd = path.resolve(args[1] ?? '.');
    const manifests = projectManifests(cwd);
    if (!manifests.length) throw new Error(`no package.json, pyproject.toml or requirements*.txt in ${cwd}`);
    ({ packages, notes, sources, lockfiles } = expandInstalls(manifests, cwd, { all: !newOnly, limit: Infinity }));
    command = `scan ${sources.map((s) => display(path.join(cwd, s.path))).join(', ')}`;
  } else if (args[0] === '--cmd') {
    command = args.slice(1).join(' ');
    if (!command) throw new Error('--cmd needs the install command');
    ({ packages, notes, sources, lockfiles } = expandInstalls(findInstalls(command), cwd));
  } else {
    packages = args.map((arg) => {
      const pkg = parseTarget(arg);
      if (!pkg) throw new Error(`cannot read "${arg}"; write npm:<name> or pypi:<name>`);
      return pkg;
    });
  }

  if (noLockfile) lockfiles = [];
  if (!packages.length && !notes.length && !lockfiles.length) {
    if (json) process.stdout.write(`${JSON.stringify({ verdict: 'ok', results: [], sources }, null, 2)}\n`);
    else process.stdout.write(`${nothingToCheck(sources)}\n`);
    return 0;
  }

  const [checked, sweeps] = await Promise.all([
    checkAll(packages, { cwd, cache: noCache ? null : openCache() }),
    sweepLockfiles(lockfiles),
  ]);
  const swept = sweepReport(sweeps, cwd, { mentionVulnerable: args[0] === 'scan' });
  const results = [...checked, ...swept.results];
  notes = [...notes, ...swept.notes];
  const verdict = overall(results, notes);
  if (json) process.stdout.write(`${JSON.stringify({ verdict, results, notes, sources }, null, 2)}\n`);
  else process.stdout.write(renderResults(results, { command, notes }));
  if (failOn === 'block' && verdict === 'warn') return 0;
  return EXIT[verdict];
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`pkgguard: ${err.message}\n\n${USAGE}\n`);
    process.exitCode = 3;
  },
);
