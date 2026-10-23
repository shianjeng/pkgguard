// Remembers packages that came back clean, so an agent that retries the same
// install, or a `pip install -r` run again and again, does not re-query every
// registry. Anything flagged is always checked afresh.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CACHE_TTL_MS = 6 * 3_600_000;

// Results are only valid for the code that produced them: a new pkgguard may
// judge or word things differently. The file name carries a fingerprint of the
// checking code, so an upgrade starts from an empty cache.
function fingerprint() {
  let mark = 'v2';
  for (const name of ['check.mjs', 'report.mjs', 'registries.mjs', 'similar.mjs']) {
    try {
      const stat = fs.statSync(new URL(`./${name}`, import.meta.url));
      mark += `-${stat.size.toString(36)}${Math.round(stat.mtimeMs).toString(36)}`;
    } catch {}
  }
  return mark;
}

export function cacheDir(env = process.env) {
  if (env.PKGGUARD_CACHE_DIR) return env.PKGGUARD_CACHE_DIR;
  const base = env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'pkgguard');
}

export function cacheKey(pkg) {
  return `${pkg.ecosystem}:${pkg.name}@${pkg.requested ?? ''}`;
}

export class ResultCache {
  #file;
  #entries = {};
  #dirty = false;

  constructor({ dir = cacheDir(), now = Date.now(), ttl = CACHE_TTL_MS } = {}) {
    this.now = now;
    this.ttl = ttl;
    this.#file = path.join(dir, `results-${fingerprint()}.json`);
    try {
      const data = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
      for (const [key, entry] of Object.entries(data)) if (now - entry.at < ttl) this.#entries[key] = entry;
    } catch {}
  }

  get(pkg) {
    return this.#entries[cacheKey(pkg)]?.result ?? null;
  }

  set(pkg, result) {
    if (result.verdict !== 'ok' && result.verdict !== 'info') return;
    this.#entries[cacheKey(pkg)] = { at: this.now, result };
    this.#dirty = true;
  }

  save() {
    if (!this.#dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
      const tmp = `${this.#file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.#entries), { mode: 0o600 });
      fs.renameSync(tmp, this.#file);
      for (const name of fs.readdirSync(path.dirname(this.#file))) {
        if (/^results-.*\.json$/.test(name) && name !== path.basename(this.#file)) fs.rmSync(path.join(path.dirname(this.#file), name), { force: true });
      }
    } catch {
      // A cache that cannot be written only costs speed.
    }
  }
}

export function openCache(env = process.env) {
  return env.PKGGUARD_NO_CACHE ? null : new ResultCache({ dir: cacheDir(env) });
}
