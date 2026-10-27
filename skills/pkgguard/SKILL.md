---
name: pkgguard
description: Check npm and PyPI packages before installing or running them. Use this before any command that adds a package not already in the lockfile, such as `npm install <pkg>`, `pnpm add`, `yarn add`, `bun add`, `npx <pkg>`, `pip install <pkg>`, `uv add`, `uvx`, `pipx`, or `poetry add`, and whenever you are about to recommend a package by name. It catches names that don't exist (hallucinated), typosquats of popular packages, known malware, brand-new packages that run install scripts, and freshly published releases that may be hijacked.
---

# pkgguard

Package names you produce from memory can be wrong, and attackers register the wrong ones. Check before you install.

## When to run it

Run it before any command that installs or executes a package by name:

- `npm install <pkg>`, `npm i`, `pnpm add`, `yarn add`, `bun add`, `npx <pkg>`, `pnpm dlx`, `bunx`, `deno add npm:<pkg>`
- `pip install <pkg>`, `python -m pip install`, `uv add`, `uv pip install`, `uvx`, `pipx install`, `poetry add`, `pdm add`

Also run it before a bare install after you added a dependency to a manifest yourself: `npm install`, `yarn`, `pnpm install`, `pip install -r requirements.txt`, `uv sync`, `poetry install`. Pass the command as is; pkgguard reads the manifest and checks only what the lockfile doesn't pin yet, so this is cheap. Run it before `npm ci` too: every install that follows a lockfile also checks each package the lockfile pins, transitive ones included, against malware reports in one request.

To check a whole project, run `node scripts/pkgguard.mjs scan <dir>`.

## How to run it

Pass the exact command you intend to run. The script is in this skill's directory:

```bash
node scripts/pkgguard.mjs --cmd "npm install zod left-pad"
```

Or name packages directly:

```bash
node scripts/pkgguard.mjs npm:zod pypi:httpx==0.27.0
```

It needs Node.js 22 or newer and network access to the npm registry, PyPI, pypistats.org and api.osv.dev. Add `--json` for structured output. Exit code: 0 OK, 1 WARN, 2 BLOCK.

## What to do with the result

- **OK**: go ahead.
- **WARN**: show the user each finding in one line, then ask before you install. For a fresh release, offer the previous version the report names.
- **BLOCK**: do not install. Tell the user what was found. If the report suggests a popular package ("Did you mean `requests`?"), ask the user whether that is what they meant. **Never swap in a different package name on your own**, and never retry with a variation of the blocked name. Guessing is how typosquats get installed.

Lines starting with `·` are notes, such as a routine fresh release or a long-standing install script. They don't need the user's attention unless they ask.

If a source can't be reached, the report says which check did not run ("not checked", "Could not reach OSV"). Say so rather than treating it as OK.

Scoped packages that your `.npmrc` maps to a private registry (`@corp:registry=...`) are not looked up publicly and pass with a note.

## Checks

| Finding | Level |
| --- | --- |
| Name doesn't exist on the registry | BLOCK |
| Reported as malware (OSV / GitHub advisories), or replaced by npm's security placeholder | BLOCK |
| Requested version doesn't exist | BLOCK |
| Looks like a popular package (one character off, separators changed, affix added, or a look-alike scope such as `@typescript_eslint`) with under 1,000 weekly downloads | BLOCK |
| First published under 7 days ago and runs an install script | BLOCK |
| Same lookalike with 1,000–50,000 weekly downloads, or with download counts unavailable | WARN |
| First published under 30 days ago | WARN |
| This version is under 72 hours old **and** something else changed: a different publisher, dropped build provenance, new install scripts, or wheels no longer shipped | WARN |
| Runs `preinstall` / `install` / `postinstall` scripts, unless the package is widely used and earlier versions ran them too | WARN |
| Ships no wheel, so `setup.py` runs (PyPI) | WARN |
| Installs from a URL or git repository, or the package name is computed at run time (`$PKG`, `$(...)`, `xargs`) | WARN |
| Deprecated, yanked, or has known vulnerabilities | WARN |
| OSV could not be reached, so malware and vulnerability data are missing | WARN |
| Fewer than 100 downloads last week | WARN |
