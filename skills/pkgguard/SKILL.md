---
name: pkgguard
description: Check npm and PyPI packages before installing or running them. Use this before any command that adds a package not already in the lockfile, such as `npm install <pkg>`, `pnpm add`, `yarn add`, `bun add`, `npx <pkg>`, `pip install <pkg>`, `uv add`, `uvx`, `pipx`, or `poetry add`, and whenever you are about to recommend a package by name. It catches names that don't exist (hallucinated), typosquats of popular packages, known malware, brand-new packages that run install scripts, and freshly published releases that may be hijacked.
---

# pkgguard

Package names you produce from memory can be wrong, and attackers register the wrong ones. Check before you install.

## When to run it

Run it before any command that installs or executes a package by name:

- `npm install <pkg>`, `npm i`, `pnpm add`, `yarn add`, `bun add`, `npx <pkg>`, `pnpm dlx`, `bunx`
- `pip install <pkg>`, `python -m pip install`, `uv add`, `uv pip install`, `uvx`, `pipx install`, `poetry add`, `pdm add`

You don't need it for `npm install`, `npm ci`, `pip install -r requirements.txt` or `uv sync` with no new package names: those install what the lockfile already pins.

## How to run it

Pass the exact command you intend to run. The script is in this skill's directory:

```bash
node scripts/pkgguard.mjs --cmd "npm install zod left-pad"
```

Or name packages directly:

```bash
node scripts/pkgguard.mjs npm:zod pypi:httpx==0.27.0
```

It needs Node.js 18 or newer and network access to the npm registry, PyPI, pypistats.org and api.osv.dev. Add `--json` for structured output. Exit code: 0 OK, 1 WARN, 2 BLOCK.

## What to do with the result

- **OK**: go ahead.
- **WARN**: show the user each finding in one line, then ask before you install. For a fresh release, offer the previous version the report names.
- **BLOCK**: do not install. Tell the user what was found. If the report suggests a popular package ("Did you mean `requests`?"), ask the user whether that is what they meant. **Never swap in a different package name on your own**, and never retry with a variation of the blocked name. Guessing is how typosquats get installed.

If the registry can't be reached, the result is WARN with "not checked". Say so rather than treating it as OK.

## Checks

| Finding | Level |
| --- | --- |
| Name doesn't exist on the registry | BLOCK |
| Reported as malware (OSV / GitHub advisories), or replaced by npm's security placeholder | BLOCK |
| Requested version doesn't exist | BLOCK |
| Looks like a popular package (one character off, separators changed, affix added) with under 1,000 weekly downloads | BLOCK |
| First published under 7 days ago and runs an install script | BLOCK |
| Same lookalike with 1,000–50,000 weekly downloads | WARN |
| First published under 30 days ago | WARN |
| This version published under 72 hours ago (with publisher changes noted) | WARN |
| Dropped the build provenance the previous version had (npm) | WARN |
| Runs `preinstall` / `install` / `postinstall` scripts (npm), or ships no wheel (PyPI) | WARN |
| Deprecated, yanked, or has known vulnerabilities | WARN |
| Fewer than 100 downloads last week | WARN |
