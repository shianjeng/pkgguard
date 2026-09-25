#!/usr/bin/env node
// Checks npm and PyPI packages before they are installed.
//   pkgguard npm:lodash pypi:requests
//   pkgguard --cmd "npm install lodash left-pad"
// Exit codes: 0 ok, 1 warn, 2 block, 3 usage or internal error.
import { checkAll } from './lib/check.mjs';
import { findInstalls, parseNpmSpec, parsePySpec } from './lib/parse.mjs';
import { overall, renderResults } from './lib/report.mjs';

const USAGE = `Usage:
  pkgguard npm:<package>[@version] pypi:<package>[==version] ...
  pkgguard --cmd "<install command>"
Options:
  --json   print machine-readable results
Exit codes: 0 ok, 1 warn, 2 block, 3 usage error`;

const EXIT = { ok: 0, info: 0, warn: 1, block: 2 };

function parseTarget(arg) {
  const m = /^(npm|pypi|pip):(.+)$/i.exec(arg);
  if (!m) return null;
  return m[1].toLowerCase() === 'npm' ? parseNpmSpec(m[2]) : parsePySpec(m[2]);
}

async function main(argv) {
  const json = argv.includes('--json');
  const args = argv.filter((a) => a !== '--json');
  if (!args.length || args.includes('-h') || args.includes('--help')) {
    process.stdout.write(`${USAGE}\n`);
    return args.length ? 0 : 3;
  }

  let packages;
  let command = null;
  const cmdIndex = args.indexOf('--cmd');
  if (cmdIndex !== -1) {
    command = args.slice(cmdIndex + 1).join(' ');
    if (!command) throw new Error('--cmd needs the install command');
    packages = findInstalls(command);
    if (!packages.length) {
      process.stdout.write(json ? '{"verdict":"ok","results":[]}\n' : 'pkgguard: no package installs found in that command.\n');
      return 0;
    }
  } else {
    packages = args.map((arg) => {
      const pkg = parseTarget(arg);
      if (!pkg) throw new Error(`cannot read "${arg}"; write npm:<name> or pypi:<name>`);
      return pkg;
    });
  }

  const results = await checkAll(packages);
  const verdict = overall(results);
  if (json) process.stdout.write(`${JSON.stringify({ verdict, results }, null, 2)}\n`);
  else process.stdout.write(renderResults(results, { command }));
  return EXIT[verdict];
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`pkgguard: ${err.message}\n${USAGE}\n`);
    process.exitCode = 3;
  },
);
