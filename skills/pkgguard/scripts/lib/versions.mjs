// Just enough version logic to know which release an install would pick.

// ---- npm (semver ranges) ----

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const PARTIAL = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemver(value) {
  const m = SEMVER.exec(String(value).trim());
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] } : null;
}

function compareIdentifiers(a, b) {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Number(a) - Number(b);
  if (an !== bn) return an ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareSemver(a, b) {
  for (const key of ['major', 'minor', 'patch']) if (a[key] !== b[key]) return a[key] - b[key];
  if (!a.pre.length || !b.pre.length) return b.pre.length - a.pre.length;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === undefined) return -1;
    if (b.pre[i] === undefined) return 1;
    const c = compareIdentifiers(a.pre[i], b.pre[i]);
    if (c) return c;
  }
  return 0;
}

const wild = (part) => part === undefined || /^[xX*]$/.test(part);
const v = (major, minor, patch, pre = []) => ({ major, minor, patch, pre });

// One range token -> comparators [{ op, version }]. Returns null if unreadable.
function comparators(token) {
  if (token === '' || /^[xX*]$/.test(token)) return [];
  const m = /^(\^|~>?|>=|<=|>|<|=)?(.*)$/.exec(token);
  const op = m[1] ?? '';
  const p = PARTIAL.exec(m[2]);
  if (!p) return null;
  const [major, minor, patch] = [p[1], p[2], p[3]].map((x) => (wild(x) ? null : Number(x)));
  const pre = p[4] ? p[4].split('.') : [];
  if (major === null) return op === '<' || op === '>' ? null : [];
  const low = v(major, minor ?? 0, patch ?? 0, pre);
  const bump = () => (minor === null ? v(major + 1, 0, 0) : patch === null ? v(major, minor + 1, 0) : null);

  if (op === '^') {
    const upper =
      major > 0 || minor === null ? v(major + 1, 0, 0) : minor > 0 || patch === null ? v(0, minor + 1, 0) : v(0, 0, patch + 1);
    return [{ op: '>=', version: low }, { op: '<', version: upper }];
  }
  if (op.startsWith('~')) {
    return [{ op: '>=', version: low }, { op: '<', version: minor === null ? v(major + 1, 0, 0) : v(major, minor + 1, 0) }];
  }
  const upper = bump();
  if (op === '' || op === '=') {
    return upper ? [{ op: '>=', version: low }, { op: '<', version: upper }] : [{ op: '=', version: low }];
  }
  if (op === '>') return upper ? [{ op: '>=', version: upper }] : [{ op: '>', version: low }];
  if (op === '<=') return upper ? [{ op: '<', version: upper }] : [{ op: '<=', version: low }];
  return [{ op, version: low }]; // >=, <
}

export function parseRange(range) {
  const sets = [];
  for (const raw of String(range).split('||')) {
    let text = raw.trim().replace(/(\^|~>?|>=|<=|>|<|=)\s+/g, '$1');
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text);
    if (hyphen) text = `>=${hyphen[1]} <=${hyphen[2]}`;
    const set = [];
    for (const token of text.split(/\s+/)) {
      const parsed = comparators(token);
      if (!parsed) return null;
      set.push(...parsed);
    }
    sets.push(set);
  }
  return sets;
}

function test(version, { op, version: bound }) {
  const c = compareSemver(version, bound);
  return op === '>=' ? c >= 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : op === '<' ? c < 0 : c === 0;
}

function satisfiesSet(version, set) {
  if (!set.every((comparator) => test(version, comparator))) return false;
  // Prereleases only match when the range names a prerelease of the same version.
  if (!version.pre.length) return true;
  return set.some(
    ({ version: b }) => b.pre.length && b.major === version.major && b.minor === version.minor && b.patch === version.patch,
  );
}

export function satisfies(value, range) {
  const version = typeof value === 'string' ? parseSemver(value) : value;
  const sets = parseRange(range);
  return Boolean(version && sets && sets.some((set) => satisfiesSet(version, set)));
}

// What npm picks for `name@range`: the `latest` tag if it fits, otherwise the
// highest matching version. `undefined` means the range could not be read;
// `null` means nothing matches.
export function resolveRange(versions, range, latest) {
  const sets = parseRange(range);
  if (!sets) return undefined;
  const fits = (s) => {
    const parsed = parseSemver(s);
    return parsed && sets.some((set) => satisfiesSet(parsed, set));
  };
  if (latest && fits(latest)) return latest;
  let best = null;
  for (const candidate of versions) {
    if (fits(candidate) && (!best || compareSemver(parseSemver(candidate), parseSemver(best)) > 0)) best = candidate;
  }
  return best;
}

// ---- PyPI (PEP 440 equality) ----

// A comparison key under which "2.0", "2.0.0" and "2" are the same release,
// as are "1.0-RC1" and "1.0rc1".
export function pep440Key(value) {
  const s = String(value).trim().toLowerCase().replace(/^v/, '');
  const m = /^(\d+(?:\.\d+)*)(.*)$/.exec(s);
  if (!m) return s;
  const release = m[1].split('.').map((n) => String(Number(n)));
  while (release.length > 1 && release.at(-1) === '0') release.pop();
  const rest = m[2]
    .replace(/[-_.]?(alpha|a)[-_.]?(?=\d|$)/, 'a')
    .replace(/[-_.]?(beta|b)[-_.]?(?=\d|$)/, 'b')
    .replace(/[-_.]?(preview|pre|rc|c)[-_.]?(?=\d|$)/, 'rc')
    .replace(/[-_.]?(post|rev|r)[-_.]?(?=\d|$)/, '.post')
    .replace(/[-_.]?dev[-_.]?(?=\d|$)/, '.dev');
  return release.join('.') + rest;
}

export function findPep440(keys, requested) {
  const wanted = pep440Key(requested);
  return keys.find((k) => k === requested) ?? keys.find((k) => pep440Key(k) === wanted) ?? null;
}
