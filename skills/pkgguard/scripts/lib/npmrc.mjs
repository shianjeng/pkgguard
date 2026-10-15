// Scoped packages can come from a private registry (`@corp:registry=...` in an
// .npmrc). The public registry knows nothing about them, so checking them there
// would only report every internal package as hallucinated.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Registries that serve the public npm package set.
const PUBLIC = /^https?:\/\/(registry\.npmjs\.org|registry\.yarnpkg\.com|registry\.npmmirror\.com|registry\.npm\.taobao\.org)\/?$/i;
const SCOPE_LINE = /^\s*(@[a-z0-9-~][a-z0-9-._~]*):registry\s*=\s*(\S+)/i;

// Scope -> registry URL, from npm_config_* variables, then the nearest .npmrc
// walking up from `cwd`, then ~/.npmrc. The first source to name a scope wins.
export function scopeRegistries(cwd = process.cwd(), env = process.env, home = os.homedir()) {
  const map = new Map();
  const add = (scope, url) => {
    const key = scope.toLowerCase();
    if (!map.has(key)) map.set(key, url.replace(/^["']|["']$/g, ''));
  };
  for (const [key, value] of Object.entries(env)) {
    const m = /^npm_config_(@[^:]+):registry$/i.exec(key);
    if (m && value) add(m[1], value);
  }
  const files = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    files.push(path.join(dir, '.npmrc'));
    if (path.dirname(dir) === dir) break;
  }
  files.push(path.join(home, '.npmrc'));
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const m = SCOPE_LINE.exec(line);
      if (m) add(m[1], m[2]);
    }
  }
  return map;
}

// The private registry a scoped package installs from, without credentials, or null.
export function privateRegistry(name, registries) {
  if (!name.startsWith('@') || !registries) return null;
  const url = registries.get(name.split('/')[0].toLowerCase());
  if (!url || PUBLIC.test(url)) return null;
  return url.replace(/\/\/[^/@]*@/, '//');
}
