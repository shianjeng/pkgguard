#!/usr/bin/env node
// Refreshes the popular-package lists used for lookalike detection.
//   npm:  wooorm/npm-high-impact (MIT), packages ranked by downloads
//   PyPI: hugovk/top-pypi-packages, 30-day download ranking
import fs from 'node:fs';

const LIMIT = 5000;
const OUT = new URL('../skills/pkgguard/data/', import.meta.url);

async function text(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.text();
}

const npmSource = await text('https://raw.githubusercontent.com/wooorm/npm-high-impact/main/lib/top-download.js');
const npm = [...npmSource.matchAll(/^\s+'([^']+)',?$/gm)].map((m) => m[1]).slice(0, LIMIT);

const pypiSource = JSON.parse(await text('https://hugovk.github.io/top-pypi-packages/top-pypi-packages.min.json'));
const pypi = pypiSource.rows.map((row) => row.project).slice(0, LIMIT);

if (npm.length < 1000 || pypi.length < 1000) throw new Error(`suspiciously short lists: npm ${npm.length}, pypi ${pypi.length}`);

const stamp = new Date().toISOString().slice(0, 10);
fs.writeFileSync(new URL('popular-npm.txt', OUT), `# top ${npm.length} npm packages by downloads, from wooorm/npm-high-impact, ${stamp}\n${npm.join('\n')}\n`);
fs.writeFileSync(new URL('popular-pypi.txt', OUT), `# top ${pypi.length} PyPI projects by downloads, from hugovk/top-pypi-packages, ${stamp}\n${pypi.join('\n')}\n`);
console.log(`npm ${npm.length}, pypi ${pypi.length}`);
