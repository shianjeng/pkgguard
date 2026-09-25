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
    cache.set(ecosystem, { names, set: new Set(names) });
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

// Returns the popular package `name` most plausibly imitates, or null.
export function lookalike(ecosystem, name) {
  const { names, set } = popular(ecosystem);
  if (set.has(name)) return null;
  const bare = name.startsWith('@') ? null : name;
  if (!bare) return null; // scoped npm names are owned by their scope
  const stripped = strip(bare);
  for (let rank = 0; rank < names.length; rank++) {
    const target = names[rank];
    if (target.startsWith('@')) continue;
    if (strip(target) === stripped) return { name: target, rank, reason: 'the same letters with different separators' };
    if (bare.length >= 5 && target.length >= 5 && editDistance(bare, target, 1) <= 1) {
      return { name: target, rank, reason: 'one character off' };
    }
    if (rank < 500 && target.length >= 4 && AFFIXES.some((affix) => affix(target) === bare)) {
      return { name: target, rank, reason: 'the name with a prefix or suffix added' };
    }
  }
  return null;
}
