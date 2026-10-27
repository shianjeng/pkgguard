#!/usr/bin/env node
// Checks npm and PyPI packages before they are installed.
//   pkgguard npm:lodash pypi:requests
//   pkgguard --cmd "npm install lodash left-pad"
//   pkgguard scan [dir]
// Exit codes: 0 ok, 1 warn, 2 block, 3 usage or internal error.
import os from 'node:os';
import path from 'node:path';
import { openCache } from './lib/cache.mjs';
import { checkAll } from './lib/check.mjs';
import { sweepLockfiles, sweepReport } from './lib/lockfiles.mjs';
import { expandInstalls, projectManifests } from './lib/manifests.mjs';
import { findInstalls, parseNpmSpec, parsePySpec } from './lib/parse.mjs';
import { overall, renderResults } from './lib/report.mjs';

const USAGE = `Usage:
  pkgguard npm:<package>[@version] pypi:<package>[==version] ...
  pkgguard --cmd "<install command>"
  pkgguard scan [dir] [--new-only]

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

async function main(argv) {
  const args = [...argv];
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
