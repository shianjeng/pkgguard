// Every package a lockfile pins, direct or transitive, checked against OSV's
// malware reports in one batch request.
//
// Hijacked releases mostly arrive as transitive dependencies (debug@4.4.2,
// @ctrl/tinycolor@4.1.1), and `npm ci` installs whatever the lockfile says
// without asking anyone. The registry checks in check.mjs cost several
// requests per package, which is fine for the handful a command names but not
// for the hundreds a lockfile pins; malware ids are what can be checked in bulk.
import path from 'node:path';
import { read } from './manifests.mjs';
import { normalizePyName } from './parse.mjs';
import { osvBatch } from './registries.mjs';

const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-zA-Z0-9-~][a-zA-Z0-9-._~]*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function splitAt(spec) {
  const at = spec.lastIndexOf('@');
  return at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, ''];
}

// ---- npm lockfiles ----

function packageLock(text) {
  const lock = JSON.parse(text);
  const out = [];
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    const at = key.lastIndexOf('node_modules/');
    if (at === -1 || entry.link) continue; // the project itself, workspace members, symlinks
    if (entry.resolved && !/^https?:/.test(entry.resolved)) continue; // git, file:
    out.push({ name: entry.name ?? key.slice(at + 13), version: entry.version });
  }
  // lockfileVersion 1 nests dependencies instead
  const walk = (deps) => {
    for (const [name, entry] of Object.entries(deps ?? {})) {
      out.push({ name, version: entry.version });
      walk(entry.dependencies);
    }
  };
  if (!lock.packages) walk(lock.dependencies);
  return out;
}

function pnpmLock(text) {
  const out = [];
  let section = null;
  for (const line of text.split(/\r?\n/)) {
    const top = /^(\w[\w-]*):/.exec(line);
    if (top) {
      section = top[1];
      continue;
    }
    // Keys sit two spaces in: "  lodash@4.17.21:", "  '@types/node@22.20.5':",
    // "  /lodash@4.17.21:" (v6) or "  /lodash/4.17.21:" (v5). Snapshots repeat
    // packages with peer suffixes, so the packages section alone is enough.
    if (section !== 'packages') continue;
    const m = /^ {2}['"]?\/?([^\s'"]+?)['"]?:\s*$/.exec(line);
    if (!m) continue;
    const key = m[1].replace(/\(.*$/, '');
    // v5 writes name/version and appends peers after "_"; names may contain "_" too (string_decoder)
    const v5 = /^((?:@[^/]+\/)?[^/@]+)\/(\d[^/_]*)(?:_.*)?$/.exec(key);
    const [name, version] = v5 ? [v5[1], v5[2]] : splitAt(key);
    out.push({ name, version });
  }
  return out;
}

function yarnLock(text) {
  const out = [];
  const berry = /^__metadata:/m.test(text);
  for (const block of text.split(/\r?\n\r?\n/)) {
    if (berry) {
      // resolution: "react-dom@npm:19.3.1"; workspaces, patches and git have other protocols
      const m = /^\s+resolution:\s*"?(.+?)@npm:([^"\s]+)"?\s*$/m.exec(block);
      if (m) out.push({ name: m[1], version: m[2] });
      continue;
    }
    const key = /^"?((?:@[^@\s"]+\/)?[^@\s"]+)@/m.exec(block);
    const version = /^\s+version\s+"([^"]+)"/m.exec(block);
    const resolved = /^\s+resolved\s+"([^"]+)"/m.exec(block);
    if (!key || !version) continue;
    if (resolved && !/\/-\/[^/]+\.tgz/.test(resolved[1])) continue; // git, GitHub tarballs
    const alias = /^"?[^\s"]+@npm:((?:@[^@\s"]+\/)?[^@\s"]+)@/m.exec(block);
    out.push({ name: alias ? alias[1] : key[1], version: version[1] });
  }
  return out;
}

function bunLock(text) {
  // "packages": { "express": ["express@5.3.0", "", {...}, "sha512-..."] }
  return [...text.matchAll(/^\s+"[^"]+":\s*\[\s*"((?:@[^@"/]+\/)?[^@"]+)@([^"]+)"/gm)].map((m) => ({ name: m[1], version: m[2] }));
}

// ---- Python lockfiles ----

function tomlPackages(text, { keep }) {
  const out = [];
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = /^name\s*=\s*"([^"]+)"/m.exec(block);
    const version = /^version\s*=\s*"([^"]+)"/m.exec(block);
    if (name && version && keep(block)) out.push({ name: normalizePyName(name[1]), version: version[1] });
  }
  return out;
}

const PARSERS = {
  'package-lock.json': { ecosystem: 'npm', parse: packageLock },
  'npm-shrinkwrap.json': { ecosystem: 'npm', parse: packageLock },
  'pnpm-lock.yaml': { ecosystem: 'npm', parse: pnpmLock },
  'yarn.lock': { ecosystem: 'npm', parse: yarnLock },
  'bun.lock': { ecosystem: 'npm', parse: bunLock },
  // uv: only packages from an index; the project itself is "virtual" or "editable"
  'uv.lock': { ecosystem: 'pypi', parse: (t) => tomlPackages(t, { keep: (b) => /^source\s*=\s*\{\s*registry\s*=/m.test(b) }) },
  // poetry: git, path and URL sources carry a [package.source] table of that type
  'poetry.lock': { ecosystem: 'pypi', parse: (t) => tomlPackages(t, { keep: (b) => !/^type\s*=\s*"(git|directory|file|url)"/m.test(b) }) },
  'pdm.lock': { ecosystem: 'pypi', parse: (t) => tomlPackages(t, { keep: (b) => !/^(path|git|url)\s*=/m.test(b) }) },
};

// The packages a lockfile pins, deduplicated, or null when it cannot be read
// (bun.lockb is binary, a file may be corrupt).
export function lockedPackages(file) {
  const parser = PARSERS[path.basename(file)];
  const text = parser ? read(file) : null;
  if (text === null) return null;
  let raw;
  try {
    raw = parser.parse(text);
  } catch {
    return null;
  }
  const seen = new Set();
  const out = [];
  for (const { name, version } of raw) {
    if (!name || !version) continue;
    if (parser.ecosystem === 'npm' && (!NPM_NAME.test(name) || !SEMVER.test(version))) continue;
    const key = `${name}@${version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ecosystem: parser.ecosystem, name, version });
  }
  return out;
}

export async function sweepLockfile(file, options = {}) {
  const packages = lockedPackages(file);
  const ecosystem = PARSERS[path.basename(file)]?.ecosystem ?? 'npm';
  if (!packages) return { file, ecosystem, unreadable: true };
  let ids;
  try {
    ids = await osvBatch(packages, options);
  } catch (error) {
    return { file, ecosystem, total: packages.length, error: error.message };
  }
  const malicious = [];
  let vulnerable = 0;
  packages.forEach((pkg, i) => {
    const mal = ids[i].filter((id) => id.startsWith('MAL-'));
    if (mal.length) malicious.push({ ...pkg, ids: mal });
    else if (ids[i].length) vulnerable += 1;
  });
  return { file, ecosystem, total: packages.length, malicious, vulnerable };
}

export function sweepLockfiles(files, options) {
  return Promise.all(files.map((file) => sweepLockfile(file, options)));
}

const AUDIT = { npm: 'npm audit', pypi: 'pip-audit' };

// Sweep outcomes as report results (one per malicious package) and notes.
export function sweepReport(sweeps, cwd, { mentionVulnerable = false } = {}) {
  const results = [];
  const notes = [];
  for (const sweep of sweeps) {
    const name = path.relative(cwd, sweep.file) || path.basename(sweep.file);
    const shown = name.startsWith('..') ? sweep.file : name;
    if (sweep.unreadable) {
      notes.push({
        level: 'info',
        text: `${shown} could not be read, so the packages it pins were not checked against malware reports${shown.endsWith('.lockb') ? ' (it is binary; bun install --save-text-lockfile writes bun.lock)' : ''}.`,
      });
      continue;
    }
    if (sweep.error) {
      notes.push({ level: 'warn', text: `Could not check the ${sweep.total} packages pinned in ${shown} against OSV malware reports (${sweep.error}).` });
      continue;
    }
    for (const pkg of sweep.malicious) {
      results.push({
        ecosystem: pkg.ecosystem,
        name: pkg.name,
        version: pkg.version,
        from: shown,
        locked: true, // found by the lockfile sweep, not looked up one by one
        verdict: 'block',
        facts: null,
        findings: [
          {
            level: 'block',
            code: 'malicious-locked',
            text: `${shown} pins ${pkg.name}@${pkg.version}, which is reported as malicious (${pkg.ids.join(', ')}). Installing from this lockfile would run it; replace that version first.`,
          },
        ],
      });
    }
    if (!sweep.malicious.length) {
      const all = sweep.total === 1 ? 'The 1 package' : `All ${sweep.total} packages`;
      notes.push({ level: 'info', text: `${all} pinned in ${shown} ${sweep.total === 1 ? 'was' : 'were'} checked against OSV malware reports: none reported.` });
    }
    if (mentionVulnerable && sweep.vulnerable) {
      notes.push({
        level: 'info',
        text: `OSV lists known vulnerabilities for ${sweep.vulnerable} of the packages in ${shown}; ${AUDIT[sweep.ecosystem]} shows which.`,
      });
    }
  }
  return { results, notes };
}
