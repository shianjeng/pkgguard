# pkgguard

**Stop your coding agent from installing packages that don't exist, or shouldn't.**

Agents type package names from memory. Sometimes the name is wrong, and attackers register the wrong names on purpose ("slopsquatting"). Sometimes the name is right but the release is hours old and came from a hijacked account. pkgguard checks every package before your agent installs it.

```
$ npx @shianjeng/pkgguard --cmd "npm i expresss crossenv && pip install colourama numpy"

✗ BLOCK expresss@0.0.0 (npm) · 698 downloads/week · since 2016
    - Looks like the popular package "express" (one character off), but has only 698 downloads last week. Possible typosquat.
    · No source repository listed.
✗ BLOCK crossenv@0.0.2-security (npm) · 1.9k downloads/week · since 2017
    - Reported as malicious: GHSA-c2m4-w5hm-vqjw (crossenv is malware).
    - npm replaced this package with a security placeholder, which usually means it was malware.
    - Looks like the popular package "cross-env" (the same letters with different separators), but has only 1,872 downloads last week. Possible typosquat.
✗ BLOCK colourama (pypi)
    - "colourama" does not exist on PyPI. The name may be hallucinated, or the package lives on a private registry. Did you mean "colorama"?
✓ OK    numpy@2.5.4 (pypi) · 220M downloads/week · since 2006

Verdict: BLOCK. Do not install. Tell the user what pkgguard found; do not swap in a different package name without their confirmation.
```

## Install

### Claude Code: skill plus an enforcing hook

```
/plugin marketplace add shianjeng/pkgguard
/plugin install pkgguard@pkgguard
```

The plugin adds a `PreToolUse` hook. Every Bash command that installs or runs a package is checked first:

- **BLOCK**: the command is denied, and Claude is told why.
- **WARN**: the command goes to your normal permission prompt, with the findings attached. Set `PKGGUARD_ON_WARN=deny` to refuse instead, or `allow` to only block.
- **OK**: nothing changes. pkgguard never approves a command on its own.

If a registry or OSV can't be reached, the report says which check did not run and the command goes to your permission prompt. If the hook itself fails, the command goes through as if pkgguard weren't installed.

### Any agent that supports skills (Cursor, Codex CLI, Gemini CLI, OpenCode, ...)

```bash
npx skills add shianjeng/pkgguard
```

The skill tells the agent to run the check before installing. Skills are instructions, so enforcement depends on the agent following them; the Claude Code hook doesn't.

### Command line / CI

```bash
npx @shianjeng/pkgguard --cmd "npm install left-pad zod"
npx @shianjeng/pkgguard npm:zod pypi:httpx==0.27.0 --json
```

The same without the npm registry, straight from this repository:

```bash
npx github:shianjeng/pkgguard --cmd "npm install left-pad zod"
```

Exit codes: `0` OK, `1` WARN, `2` BLOCK. Needs Node.js 22 or newer.

The npm package is scoped because npm refuses the bare name `pkgguard` as too close to an unrelated `pkg-guard`. Nobody can publish `pkgguard` itself, and only this project can publish under `@shianjeng`. `npm install -g @shianjeng/pkgguard` installs a `pkgguard` command.

## What it checks

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

It understands `npm`/`pnpm`/`yarn`/`bun` installs, `npx`/`pnpm dlx`/`bunx`/`yarn dlx`, Deno `npm:` specifiers, `pip`/`python -m pip`, `uv add`/`uv pip install`/`uvx`, `pipx`, `poetry`, `pdm` and `rye`. It reads through chained commands, `bash -c`/`sh -c`, `eval`, `$(...)` and backquotes, `sudo`, env assignments and global options (`npm -g install`, `pnpm -C dir add`), and ignores redirection targets and here-document bodies. Version ranges are resolved the way npm resolves them (`react@^17` is checked as 17.0.2), and PyPI versions are compared the way pip compares them (`==2.0` matches 2.0.0). Local paths and lockfile installs (`npm ci`, `pip install -r`) are skipped. URLs, git sources, and names that only exist at run time (`npm i $PKG`, `xargs npm i`) can't be checked, so they WARN instead of passing silently.

Lookalikes are compared against the 5,000 most downloaded packages on each registry. Popular packages are never flagged, and a lookalike with more than 50,000 weekly downloads is assumed to be its own project (`preact` is not a typo of `react`). A name inside a known scope is never a lookalike, because only the scope's owner can publish there; a look-alike scope is.

Warnings are kept for things worth stopping for. A release a day old from the usual publisher, with the usual provenance and no new install scripts, is a note rather than a prompt: packages like `@types/*` publish constantly, and a prompt that always appears gets clicked through. Install scripts on widely used packages that have always had them (esbuild, sharp) are notes for the same reason. Every note is still printed.

Data comes from the npm registry, PyPI, [pypistats.org](https://pypistats.org), and [OSV.dev](https://osv.dev). No account, API key, or telemetry. Popular-package lists come from [wooorm/npm-high-impact](https://github.com/wooorm/npm-high-impact) and [hugovk/top-pypi-packages](https://github.com/hugovk/top-pypi-packages); refresh them with `npm run update-popular`.

## Limits

- A package that is old, popular and quietly malicious passes. pkgguard catches the common patterns, not everything; it is one layer, not a sandbox.
- Private registries: scoped packages that an `.npmrc` maps to another registry (`@corp:registry=...`, read from the project, its parent directories, `~/.npmrc` and `npm_config_*`) are not looked up publicly. An unscoped package, or a PyPI package from a private index, still reports as "does not exist"; approve it yourself.
- Transitive dependencies aren't checked, only the packages named in the command.

## Related

[whatleft](https://github.com/shianjeng/whatleft) shows every host your agent talked to and how much it sent, and flags anything that looks like your repository leaving the machine.

---

## 中文简介

**防止 AI 编程助手装上不存在的、仿冒的或刚被劫持的包。**

Agent 凭记忆写包名，偶尔会写错，而攻击者会专门抢注这些错误的名字（slopsquatting）。也有时候包名没错，但最新版本刚发布几个小时，来自一个被盗的账号。pkgguard 会在安装前逐个检查：

- 包名在 npm / PyPI 上不存在（很可能是 AI 编造的）→ 拦截，并提示“你是不是想装 colorama”
- 在 OSV / GitHub 公告里被报告为恶意包，或已被 npm 替换成安全占位包 → 拦截
- 和热门包只差一个字符、分隔符不同或多了前后缀，且下载量很低 → 拦截
- 新发布且带安装脚本、刚发布的版本同时换了发布者或丢了构建来源证明（provenance）或新增了安装脚本、已弃用、有已知漏洞、来自 URL / git 或包名运行时才确定（`$PKG`、`xargs`）、连不上 OSV 等 → 警告
- 只是刚发了新版、其他都没变，或热门包一直以来就带安装脚本 → 只显示说明，不弹确认，避免警告多到被习惯性忽略
- `.npmrc` 里映射到私有源的 scope（`@corp:registry=...`）不会被误报为“不存在”

**Claude Code 安装（带强制 hook）：**

```
/plugin marketplace add shianjeng/pkgguard
/plugin install pkgguard@pkgguard
```

**其他支持 skill 的 agent：** `npx skills add shianjeng/pkgguard`

**命令行：** `npx @shianjeng/pkgguard --cmd "npm install xxx"`（npm 认为 `pkgguard` 和已有的 `pkg-guard` 太像，不允许任何人注册，所以用带 scope 的名字），或不经过 npm 直接从本仓库运行：`npx github:shianjeng/pkgguard --cmd "npm install xxx"`（需要 Node.js 22 及以上）

零依赖，不需要账号或 API key，也不上报任何数据。

## License

MIT
