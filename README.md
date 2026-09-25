# pkgguard

**Stop your coding agent from installing packages that don't exist, or shouldn't.**

Agents type package names from memory. Sometimes the name is wrong, and attackers register the wrong names on purpose ("slopsquatting"). Sometimes the name is right but the release is hours old and came from a hijacked account. pkgguard checks every package before your agent installs it.

```
$ npx pkgguard --cmd "npm i expresss crossenv && pip install colourama numpy"

✗ BLOCK expresss@0.0.0 (npm) · 535 downloads/week · since 2016
    - Looks like the popular package "express" (one character off), but has only 535 downloads last week. Possible typosquat.
✗ BLOCK crossenv@0.0.2-security (npm) · 1.5k downloads/week · since 2017
    - Reported as malicious: GHSA-c2m4-w5hm-vqjw (crossenv is malware).
    - npm replaced this package with a security placeholder, which usually means it was malware.
    - Looks like the popular package "cross-env" (the same letters with different separators), but has only 1,496 downloads last week. Possible typosquat.
✗ BLOCK colourama (pypi)
    - "colourama" does not exist on PyPI. The name may be hallucinated, or the package lives on a private registry. Did you mean "colorama"?
✓ OK    numpy@2.5.3 (pypi) · 183M downloads/week · since 2006

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

If a registry is down or the hook fails, the command goes through as if pkgguard weren't installed.

### Any agent that supports skills (Cursor, Codex CLI, Gemini CLI, OpenCode, ...)

```bash
npx skills add shianjeng/pkgguard
```

The skill tells the agent to run the check before installing. Skills are instructions, so enforcement depends on the agent following them; the Claude Code hook doesn't.

### Command line / CI

```bash
npx pkgguard --cmd "npm install left-pad zod"
npx pkgguard npm:zod pypi:httpx==0.27.0 --json
```

Exit codes: `0` OK, `1` WARN, `2` BLOCK.

## What it checks

| Finding | Level |
| --- | --- |
| Name doesn't exist on the registry | BLOCK |
| Reported as malware (OSV / GitHub advisories) or replaced by npm's security placeholder | BLOCK |
| Requested version doesn't exist | BLOCK |
| Looks like a popular package (one character off, `-`/`_`/`.` swapped, affix like `-js` or `python-` added) with under 1,000 weekly downloads | BLOCK |
| First published under 7 days ago **and** runs an install script | BLOCK |
| Same lookalike with 1,000–50,000 weekly downloads | WARN |
| First published under 30 days ago | WARN |
| This version is under 72 hours old; the previous version and any publisher change are shown | WARN |
| The previous npm version had build provenance and this one doesn't | WARN |
| Runs `preinstall`/`install`/`postinstall` (npm) or ships no wheel, so `setup.py` runs (PyPI) | WARN |
| Deprecated, yanked, or has known vulnerabilities | WARN |
| Fewer than 100 downloads last week | WARN |

It understands `npm`/`pnpm`/`yarn`/`bun` installs, `npx`/`pnpm dlx`/`bunx`/`yarn dlx`, `pip`/`python -m pip`, `uv add`/`uv pip install`/`uvx`, `pipx`, `poetry`, `pdm` and `rye`, including chained commands, `sudo`, env assignments, aliases (`x@npm:y`) and version specifiers. Local paths, URLs, git sources and lockfile installs (`npm ci`, `pip install -r`) are skipped.

Lookalikes are compared against the 5,000 most downloaded packages on each registry. Popular packages are never flagged, and a lookalike with more than 50,000 weekly downloads is assumed to be its own project (`preact` is not a typo of `react`).

Data comes from the npm registry, PyPI, [pypistats.org](https://pypistats.org), and [OSV.dev](https://osv.dev). No account, API key, or telemetry. Popular-package lists come from [wooorm/npm-high-impact](https://github.com/wooorm/npm-high-impact) and [hugovk/top-pypi-packages](https://github.com/hugovk/top-pypi-packages); refresh them with `npm run update-popular`.

## Limits

- A package that is old, popular and quietly malicious passes. pkgguard catches the common patterns, not everything; it is one layer, not a sandbox.
- Private registries: a package that only exists on your internal registry reports as "does not exist". Tell your agent, or approve it yourself.
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
- 新发布且带安装脚本、最新版本发布不到 72 小时、丢失了构建来源证明（provenance）、已弃用、有已知漏洞等 → 警告

**Claude Code 安装（带强制 hook）：**

```
/plugin marketplace add shianjeng/pkgguard
/plugin install pkgguard@pkgguard
```

**其他支持 skill 的 agent：** `npx skills add shianjeng/pkgguard`

**命令行：** `npx pkgguard --cmd "npm install xxx"`

零依赖，不需要账号或 API key，也不上报任何数据。

## License

MIT
