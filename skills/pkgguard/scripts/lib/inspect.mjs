// One shell command in, one verdict out: the path the agent hooks, the shell
// guard and `pkgguard --cmd` share.
import { checkAll } from './check.mjs';
import { sweepLockfiles, sweepReport } from './lockfiles.mjs';
import { expandInstalls } from './manifests.mjs';
import { findInstalls } from './parse.mjs';
import { overall } from './report.mjs';

// Returns null when the command installs nothing pkgguard can see.
export async function inspectCommand(command, cwd, { cache = null, fetchImpl, env } = {}) {
  // A bare `npm install` or `pip install -r` brings in whatever the manifest lists,
  // and an install that follows a lockfile brings in everything it pins.
  const { packages, notes: expandNotes, lockfiles } = expandInstalls(findInstalls(command), cwd);
  if (!packages.length && !expandNotes.length && !lockfiles.length) return null;
  const [checked, sweeps] = await Promise.all([
    checkAll(packages, { cwd, env, cache, fetchImpl }),
    sweepLockfiles(lockfiles, { fetchImpl }),
  ]);
  const swept = sweepReport(sweeps, cwd);
  const results = [...checked, ...swept.results];
  const notes = [...expandNotes, ...swept.notes];
  return { results, notes, verdict: overall(results, notes) };
}
