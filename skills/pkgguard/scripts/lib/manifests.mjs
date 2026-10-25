// Turns "install whatever this file lists" into concrete packages.
//
// An agent can add a dependency by editing package.json or requirements.txt
// and then running a bare `npm install` or `pip install -r`. The command names
// no package, so this is where those packages are found. Dependencies already
// pinned in a lockfile were installed before and are skipped, which keeps a
// routine `npm install` free.
import fs from 'node:fs';
import path from 'node:path';
import { normalizePyName, parseNpmSpec, parsePySpec } from './parse.mjs';
import { satisfies } from './versions.mjs';

export const MAX_MANIFEST_PACKAGES = 50;

const NPM_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const NPM_LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];
const PY_LOCKFILES = ['uv.lock', 'poetry.lock', 'pdm.lock'];
const LOCAL_SPEC = /^(file:|link:|workspace:|portal:|patch:|\.{0,2}\/)/;

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

// The nearest of `names` in `dir` or its parents (workspaces keep one lockfile at the root).
function findUp(dir, names, levels = 6) {
  for (let d = dir, i = 0; i < levels; i++) {
    for (const name of names) {
      const file = path.join(d, name);
      if (fs.existsSync(file)) return file;
    }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

// ---- npm ----

// A predicate telling whether a dependency (name, range) is already pinned, or
// null when there is no lockfile at all.
function npmLocked(dir) {
  const file = findUp(dir, NPM_LOCKFILES);
  if (!file) return null;
  const text = file.endsWith('.lockb') ? fs.readFileSync(file).toString('latin1') : read(file) ?? '';
  if (/(package-lock|npm-shrinkwrap)\.json$/.test(file)) {
    try {
      const lock = JSON.parse(text);
      const versions = new Map();
      for (const [key, entry] of Object.entries(lock.packages ?? {})) {
        const at = key.lastIndexOf('node_modules/');
        if (at !== -1 && !versions.has(key.slice(at + 13))) versions.set(key.slice(at + 13), entry.version);
      }
      for (const [name, entry] of Object.entries(lock.dependencies ?? {})) if (!versions.has(name)) versions.set(name, entry.version);
      // A range the locked version no longer satisfies means npm will fetch a new version.
      return (name, range) => versions.has(name) && (!range || !/^[\d^~<>=*x\s|.-]+$/i.test(range) || satisfies(versions.get(name), range));
    } catch {
      // fall through to the text heuristics
    }
  }
  // The other lockfiles record the range each dependency was declared with, so
  // a dependency counts as pinned only while package.json still asks for that
  // same range. Bumping it to a new range means new code gets downloaded.
  const base = path.basename(file);
  if (base === 'yarn.lock') {
    // v1:   zod@^4.0.0, zod@^4.1.0:      berry:  "zod@npm:^4.0.0":
    return (name, range) => keyed(text, `${escape(name)}@(npm:)?${escape(range)}`);
  }
  if (base === 'pnpm-lock.yaml' && /^\s+specifier:/m.test(text)) {
    //   zod:
    //     specifier: ^4.0.0
    return (name, range) =>
      new RegExp(`^\\s+['"]?${escape(name)}['"]?:\\s*\\n\\s+specifier:\\s*['"]?${escape(range)}['"]?\\s*$`, 'm').test(text);
  }
  if (base === 'bun.lock') {
    // "workspaces": { "": { "dependencies": { "zod": "^4.0.0" } } }
    return (name, range) => new RegExp(`"${escape(name)}":\\s*"${escape(range)}"`).test(text);
  }
  // bun.lockb is binary and old pnpm lockfiles have no specifiers: fall back to the name.
  return (name) => {
    const n = escape(name);
    return new RegExp(`(^|[\\s"'/,(])${n}@|node_modules/${n}["/]|^\\s+['"]?${n}['"]?:\\s*$`, 'm').test(text);
  };
}

// Whether a yarn.lock entry key (a quoted or bare, comma separated list of
// name@range descriptors ending in a colon) contains `descriptor`.
function keyed(text, descriptor) {
  return new RegExp(`^"?(?:[^\\n]*?,\\s*"?)?${descriptor}"?(?:,|:\\s*$)`, 'm').test(text);
}

function npmDependencies(file) {
  let json;
  try {
    json = JSON.parse(read(file));
  } catch {
    return null;
  }
  const deps = [];
  for (const field of NPM_FIELDS) {
    for (const [name, value] of Object.entries(json?.[field] ?? {})) deps.push({ name, value: String(value), field });
  }
  return deps;
}

function npmPackage(name, value) {
  if (LOCAL_SPEC.test(value)) return null;
  if (value.startsWith('npm:')) return parseNpmSpec(value);
  // URLs, git, GitHub shorthand: parseNpmSpec reports them as external.
  const remote = parseNpmSpec(value);
  if (remote?.kind === 'external') return { ...remote, name: `${name} (${value})` };
  const pkg = parseNpmSpec(name);
  if (!pkg) return null;
  const range = value === '*' || value === '' || value === 'latest' || value.startsWith('catalog:') ? null : value;
  return { ...pkg, requested: range, version: /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(range ?? '') ? range : null };
}

function expandNpm(file, { all }) {
  const deps = npmDependencies(file);
  if (!deps) return { packages: [], missing: true };
  const locked = all ? null : npmLocked(path.dirname(file));
  const packages = [];
  for (const { name, value } of deps) {
    if (locked && locked(name, value)) continue;
    const pkg = npmPackage(name, value);
    if (pkg) packages.push(pkg);
  }
  return { packages, total: deps.length, lockfile: Boolean(locked) };
}

// ---- Python ----

function requirementLines(file, depth = 0, seen = new Set()) {
  const text = read(file);
  if (text === null) return null;
  if (seen.has(file) || depth > 4) return [];
  seen.add(file);
  const out = [];
  const lines = text.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  for (let raw of lines) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const nested = /^(-r|--requirement)[\s=]+(\S+)/.exec(line);
    if (nested) {
      out.push(...(requirementLines(path.resolve(path.dirname(file), nested[2]), depth + 1, seen) ?? []));
      continue;
    }
    const editable = /^(-e|--editable)[\s=]+(\S+)/.exec(line);
    if (editable) {
      out.push(editable[2]);
      continue;
    }
    if (line.startsWith('-')) continue; // -c, -i, --hash and other options
    out.push(line.replace(/\s+--hash[=\s]\S+/g, ''));
  }
  return out;
}

// Just enough TOML for dependency lists: string arrays under [project],
// [project.optional-dependencies] and [dependency-groups], and the key/value
// tables Poetry uses.
export function pyprojectRequirements(text) {
  const out = [];
  let table = '';
  const lines = text.split(/\r?\n/);
  const strings = (chunk) => [...chunk.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+#.*$/, '').trim();
    const header = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (header) {
      table = header[1].trim();
      continue;
    }
    const kv = /^([\w.-]+|"[^"]+")\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].replace(/"/g, '');
    let value = kv[2];
    const arrayTable = (table === 'project' && key === 'dependencies') || table === 'project.optional-dependencies' || table === 'dependency-groups';
    if (arrayTable && value.startsWith('[')) {
      while (!/\]\s*$/.test(value) && i + 1 < lines.length) value += ` ${lines[++i].replace(/\s+#.*$/, '').trim()}`;
      // Inline tables ({include-group = "docs"}) are not requirements.
      out.push(...strings(value.replace(/\{[^}]*\}/g, '')));
      continue;
    }
    if (/^tool\.poetry\.(dev-)?dependencies$|^tool\.poetry\.group\.[^.]+\.dependencies$/.test(table) && key !== 'python') {
      if (value.startsWith('{')) {
        if (/\b(git|url)\s*=/.test(value)) out.push(`${key} @ ${strings(value)[0] ?? 'remote'}`);
        else if (!/\bpath\s*=/.test(value)) out.push(key);
      } else {
        out.push(key);
      }
    }
  }
  return out;
}

// Specifier sets compare equal regardless of spacing and order: ">=1, <2" is "<2,>=1".
function specifierKey(spec) {
  return (spec ?? '').replace(/\s+/g, '').split(',').filter(Boolean).sort().join(',');
}

function pyLocked(dir) {
  const file = findUp(dir, PY_LOCKFILES);
  if (!file) return null;
  const text = read(file) ?? '';
  // uv.lock records what the project asked for under [package.metadata]:
  //   requires-dist = [{ name = "httpx", specifier = ">=0.27" }, { name = "rich" }]
  // so a changed specifier means new code, as with the npm lockfiles.
  if (path.basename(file) === 'uv.lock' && /^\[package\.metadata\]/m.test(text)) {
    const declared = new Map();
    for (const block of text.split(/^\[\[package\]\]/m)) {
      const metadata = block.split(/^\[package\.metadata\]/m)[1];
      if (!metadata) continue;
      for (const m of metadata.matchAll(/\{\s*name\s*=\s*"([^"]+)"([^}]*)\}/g)) {
        const spec = /specifier\s*=\s*"([^"]*)"/.exec(m[2])?.[1] ?? '';
        const name = normalizePyName(m[1]);
        if (!declared.has(name)) declared.set(name, new Set());
        declared.get(name).add(specifierKey(spec));
      }
    }
    if (declared.size) return (name, requested) => declared.get(name)?.has(specifierKey(requested)) ?? false;
  }
  // poetry.lock and pdm.lock keep only a hash of the declared requirements.
  const names = new Set([...text.matchAll(/^name\s*=\s*"([^"]+)"/gm)].map((m) => normalizePyName(m[1])));
  return (name) => names.has(name);
}

function expandPython(file, { all }) {
  const isPyproject = path.basename(file) === 'pyproject.toml';
  const text = isPyproject ? read(file) : null;
  const lines = isPyproject ? (text === null ? null : pyprojectRequirements(text)) : requirementLines(file);
  if (!lines) return { packages: [], missing: true };
  // Requirements files have no lockfile; pyproject projects usually do.
  const locked = all || !isPyproject ? null : pyLocked(path.dirname(file));
  const packages = [];
  for (const line of lines) {
    const pkg = parsePySpec(line);
    if (!pkg || (locked && pkg.kind !== 'external' && locked(pkg.name, pkg.requested))) continue;
    packages.push(pkg);
  }
  return { packages, total: lines.length, lockfile: Boolean(locked) };
}

// ---- entry points ----

export function expandManifest(file, ecosystem, options = {}) {
  return ecosystem === 'npm' ? expandNpm(file, options) : expandPython(file, options);
}

// Replaces manifest entries from findInstalls() with the packages they would
// install. Returns the packages plus notes about what could not be read.
export function expandInstalls(found, cwd = process.cwd(), { all = false, limit = MAX_MANIFEST_PACKAGES } = {}) {
  const packages = [];
  const notes = [];
  const sources = [];
  const seen = new Set();
  for (const entry of found) {
    if (entry.kind !== 'manifest') {
      packages.push(entry);
      continue;
    }
    if (entry.path === null) {
      notes.push({ level: 'warn', text: `Could not tell which directory "${entry.spec}" runs in, so the packages it installs were not checked.` });
      continue;
    }
    const file = path.resolve(cwd, entry.path);
    const { packages: listed, missing, total, lockfile } = expandManifest(file, entry.ecosystem, { all });
    if (missing) continue; // the install itself will fail on a missing or broken file
    sources.push({ path: entry.path, total, toCheck: listed.length, lockfile });
    for (const pkg of listed) {
      const key = `${pkg.ecosystem}:${pkg.name}@${pkg.requested ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      packages.push({ ...pkg, from: entry.path });
    }
  }
  const fromFiles = packages.filter((p) => p.from);
  if (fromFiles.length > limit) {
    const dropped = new Set(fromFiles.slice(limit));
    notes.push({
      level: 'warn',
      text: `${dropped.size} more dependencies from manifest files were not checked. Run "pkgguard scan" to check them all.`,
    });
    return { packages: packages.filter((p) => !dropped.has(p)), notes, sources };
  }
  return { packages, notes, sources };
}

// Manifests in a project directory, for `pkgguard scan`.
export function projectManifests(dir) {
  const out = [];
  if (fs.existsSync(path.join(dir, 'package.json'))) out.push({ ecosystem: 'npm', kind: 'manifest', path: 'package.json', name: 'package.json' });
  if (fs.existsSync(path.join(dir, 'pyproject.toml'))) out.push({ ecosystem: 'pypi', kind: 'manifest', path: 'pyproject.toml', name: 'pyproject.toml' });
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {}
  for (const name of entries.sort()) {
    if (/^requirements.*\.(txt|in)$/i.test(name)) out.push({ ecosystem: 'pypi', kind: 'manifest', path: name, name });
  }
  return out;
}
