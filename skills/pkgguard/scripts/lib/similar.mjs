import fs from 'node:fs';
import { normalizePyName } from './parse.mjs';

const DATA = new URL('../../data/', import.meta.url);
const cache = new Map();

// Popular package names, most downloaded first. See tools/update-popular.mjs.
export function popular(ecosystem) {
  if (!cache.has(ecosystem)) {
    let names = [];
    try {
      names = fs
        .readFileSync(new URL(`popular-${ecosystem}.txt`, DATA), 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
    } catch {}
    if (ecosystem === 'pypi') names = names.map(normalizePyName);
    const scopes = new Set(names.filter((n) => n.startsWith('@')).map((n) => n.slice(1).split('/')[0]));
    cache.set(ecosystem, { names, set: new Set(names), scopes });
  }
  return cache.get(ecosystem);
}

// Optimal string alignment distance (Levenshtein plus adjacent transpositions),
// giving up early once it exceeds `max`.
export function editDistance(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows = [Array.from({ length: b.length + 1 }, (_, j) => j)];
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(rows[i - 1][j] + 1, row[j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, rows[i - 2][j - 2] + 1);
      row.push(value);
      best = Math.min(best, value);
    }
    if (best > max) return max + 1;
    rows.push(row);
  }
  return rows[a.length][b.length];
}

const strip = (name) => name.replace(/[-_.]/g, '');
const AFFIXES = [
  (p) => `${p}-js`,
  (p) => `${p}js`,
  (p) => `${p}.js`,
  (p) => `node-${p}`,
  (p) => `${p}-node`,
  (p) => `py${p}`,
  (p) => `python-${p}`,
  (p) => `${p}-python`,
  (p) => `${p}2`,
  (p) => `${p}-dev`,
];

// Words people append to a package name. A popular name plus one of these is a
// common shape for a hallucinated or squatted name (requests-utils), and also
// for plenty of honest small packages, so such a match is weak: it can warn,
// never block.
const SUFFIX_WORDS = ['utils', 'util', 'helper', 'helpers', 'lib', 'tools', 'toolkit', 'sdk', 'api', 'client', 'core', 'plus',
  'extra', 'extras', 'ext', 'pro', 'lite', 'fast', 'next', 'extended', 'wrapper', 'fix', 'patch'];

// The two typos that stay rare between real names, even short ones: two
// neighbouring letters swapped (vtie), or one letter doubled (yamll). Any
// single edit is too loose below five letters: gsap/asap, mqtt/mitt.
function swapped(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i + 1 < a.length; i++) {
    if (a[i] !== a[i + 1] && a.slice(0, i) + a[i + 1] + a[i] + a.slice(i + 2) === b) return true;
  }
  return false;
}

function doubled(a, b) {
  if (a.length !== b.length + 1) return false;
  for (let i = 0; i < b.length; i++) if (b.slice(0, i + 1) + b[i] + b.slice(i + 1) === a) return true;
  return false;
}

// Returns the popular package `name` most plausibly imitates, or null. A
// strong match anywhere in the list wins over a weak one near the top.
export function lookalike(ecosystem, name) {
  const { names, set } = popular(ecosystem);
  if (set.has(name)) return null;
  if (name.startsWith('@')) return scopedLookalike(name);
  const bare = name;
  const stripped = strip(bare);
  for (let rank = 0; rank < names.length; rank++) {
    const target = names[rank];
    if (target.startsWith('@')) continue;
    if (strip(target) === stripped) return { name: target, rank, reason: 'the same letters with different separators' };
    if (bare.length >= 5 && target.length >= 5 && editDistance(bare, target, 1) <= 1) {
      return { name: target, rank, reason: 'one character off' };
    }
    if (target.length === 4 && swapped(bare, target)) return { name: target, rank, reason: 'two letters swapped' };
    if (target.length === 4 && doubled(bare, target)) return { name: target, rank, reason: 'a letter doubled' };
    if (rank < 500 && target.length >= 4 && AFFIXES.some((affix) => affix(target) === bare)) {
      return { name: target, rank, reason: 'the name with a prefix or suffix added' };
    }
  }
  for (let rank = 0; rank < Math.min(500, names.length); rank++) {
    const target = names[rank];
    if (target.startsWith('@') || target.length < 4) continue;
    const word = SUFFIX_WORDS.find((w) => stripped === strip(target) + w);
    if (word) return { name: target, rank, reason: `the name with "${word}" added`, weak: true };
  }
  return null;
}

// Only a scope's owner can publish inside it, so a name under a known scope
// (@types/whatever) cannot be a squat. A look-alike scope can:
// @typescript_eslint/parser for @typescript-eslint/parser.
function scopedLookalike(name) {
  const { names, scopes } = popular('npm');
  const [scope, bare] = name.slice(1).split('/');
  if (!bare || scopes.has(scope)) return null;
  const close = (a, b) => strip(a) === strip(b) || (a.length >= 4 && b.length >= 4 && editDistance(a, b, 1) <= 1);
  for (let rank = 0; rank < names.length; rank++) {
    const target = names[rank];
    if (!target.startsWith('@')) continue;
    const [targetScope, targetBare] = target.slice(1).split('/');
    if (close(scope, targetScope) && (bare === targetBare || close(bare, targetBare))) {
      return { name: target, rank, reason: `a different scope that looks like @${targetScope}` };
    }
  }
  return null;
}
