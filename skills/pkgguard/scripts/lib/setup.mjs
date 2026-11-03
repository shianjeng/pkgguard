// `pkgguard init`, `doctor` and `uninstall`: wire pkgguard into every coding
// agent on this machine and into the user's shell, check that it works, and
// take it out again.
//
// The checking code is copied to ~/.pkgguard/app first. People run init
// through npx, whose cache is cleared from time to time, and a hook that
// points into a deleted directory silently stops checking.
//
// Rules for touching someone's config: back each file up once before the
// first change (so the backup is the pre-pkgguard version), only add or
// remove pkgguard's own entries, leave a file alone if it cannot be parsed,
// and make every step safe to run twice.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAYBE_INSTALL } from './parse.mjs';
import { BLOCK_START, rcBlock, SHELLS, shellScript, withoutRcBlock, withRcBlock } from './shell.mjs';
import { VERSION } from './version.mjs';

// skills/pkgguard: the directory with SKILL.md, scripts/ and data/
export const SKILL_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MARKETPLACE = 'shianjeng/pkgguard';
const PLUGIN = 'pkgguard@pkgguard';

export function locations({ home = os.homedir(), env = process.env } = {}) {
  const base = env.PKGGUARD_HOME || path.join(home, '.pkgguard');
  return {
    home,
    base,
    app: path.join(base, 'app'),
    hook: path.join(base, 'app', 'scripts', 'hook.mjs'),
    cli: path.join(base, 'app', 'scripts', 'pkgguard.mjs'),
  };
}

const quoteArg = (p) => `"${String(p).replace(/(["\\$`])/g, '\\$1')}"`;
const isOurs = (command) => typeof command === 'string' && command.includes('hook.mjs') && command.includes('pkgguard');

export function hookCommand(node, hook, agent) {
  return `${quoteArg(node)} ${quoteArg(hook)} --agent ${agent}`;
}

// ---- files ----

function backupOnce(file) {
  const backup = `${file}.pkgguard-backup`;
  if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup);
  return backup;
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  backupOnce(file);
  fs.writeFileSync(file, text);
}

// After removing pkgguard: a file pkgguard created (no backup exists, so it
// was not there before) and that is now empty goes away again.
function writeOrRemove(file, text, empty) {
  if (empty && !fs.existsSync(`${file}.pkgguard-backup`)) fs.rmSync(file, { force: true });
  else writeFile(file, text);
}

// Applies `mutate` to a JSON file. Returns { changed } or { error } when the
// file exists but is not plain JSON (a comment, a trailing comma), in which
// case nothing is written.
function editJson(file, mutate, { dryRun = false } = {}) {
  let data = {};
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8');
    if (text.trim()) {
      try {
        data = JSON.parse(text);
      } catch (err) {
        return { error: `${file} is not plain JSON (${err.message}), so pkgguard left it alone` };
      }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: `${file} does not hold a JSON object` };
  }
  const before = JSON.stringify(data);
  mutate(data);
  if (JSON.stringify(data) === before) return { changed: false };
  // Cursor's hooks.json keeps a "version" key; with nothing else left it is empty too.
  if (!dryRun) writeOrRemove(file, `${JSON.stringify(data, null, 2)}\n`, !Object.keys(data).filter((k) => k !== 'version').length);
  return { changed: true };
}

// Removes pkgguard's entries from `list` (an array of matcher groups or of
// hooks), dropping groups that held nothing else.
function withoutOurs(list, nested) {
  if (!Array.isArray(list)) return [];
  if (!nested) return list.filter((entry) => !isOurs(entry?.command));
  return list
    .map((group) => ({ ...group, hooks: (group?.hooks ?? []).filter((h) => !isOurs(h?.command)) }))
    .filter((group) => group.hooks.length);
}

// ---- targets ----

function which(bin, env = process.env) {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, bin))) return path.join(dir, bin);
  }
  return null;
}

function userShell(env) {
  const name = path.basename(env.SHELL ?? '');
  return SHELLS.includes(name) ? name : null;
}

function rcFile(shell, { home, env }) {
  if (shell === 'zsh') return path.join(env.ZDOTDIR || home, '.zshrc');
  if (shell === 'bash') return path.join(home, '.bashrc');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'fish', 'conf.d', 'pkgguard.fish');
}

// Every target describes where it lives, whether it is present, and how to
// add, check and remove pkgguard. `ctx` carries home, env, node, the
// locations and a `run` function for external commands (swapped in tests).
export const TARGETS = [
  {
    id: 'claude',
    label: 'Claude Code',
    present: (ctx) => Boolean(ctx.which('claude')) || fs.existsSync(path.join(ctx.home, '.claude')),
    where: () => 'plugin pkgguard@pkgguard (skill and PreToolUse hook)',
    install(ctx) {
      if (!ctx.which('claude')) {
        return { manual: `Claude Code's CLI is not on PATH. Inside Claude Code run:\n  /plugin marketplace add ${MARKETPLACE}\n  /plugin install ${PLUGIN}` };
      }
      const listed = ctx.run('claude', ['plugin', 'list']);
      if (/\bpkgguard\b/.test(listed.stdout)) return { changed: false };
      if (ctx.dryRun) return { changed: true };
      const markets = ctx.run('claude', ['plugin', 'marketplace', 'list']);
      if (!/\bpkgguard\b/.test(markets.stdout)) {
        const added = ctx.run('claude', ['plugin', 'marketplace', 'add', MARKETPLACE]);
        if (added.status !== 0) return { error: `claude plugin marketplace add failed: ${added.stderr.trim() || added.stdout.trim()}` };
      }
      const installed = ctx.run('claude', ['plugin', 'install', PLUGIN]);
      if (installed.status !== 0) return { error: `claude plugin install failed: ${installed.stderr.trim() || installed.stdout.trim()}` };
      return { changed: true };
    },
    configured: (ctx) => (ctx.which('claude') ? /\bpkgguard\b/.test(ctx.run('claude', ['plugin', 'list']).stdout) : null),
    uninstall(ctx) {
      if (!ctx.which('claude')) return { changed: false };
      if (!/\bpkgguard\b/.test(ctx.run('claude', ['plugin', 'list']).stdout)) return { changed: false };
      if (ctx.dryRun) return { changed: true };
      const removed = ctx.run('claude', ['plugin', 'uninstall', PLUGIN]);
      return removed.status === 0 ? { changed: true } : { error: `claude plugin uninstall failed: ${removed.stderr.trim()}` };
    },
    selfTest: { agent: 'claude', input: (command, cwd) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd }) },
  },
  {
    id: 'cursor',
    label: 'Cursor',
    file: (ctx) => path.join(ctx.home, '.cursor', 'hooks.json'),
    present: (ctx) => fs.existsSync(path.join(ctx.home, '.cursor')),
    where: (ctx) => `${ctx.show(path.join(ctx.home, '.cursor', 'hooks.json'))} (beforeShellExecution)`,
    install(ctx) {
      return editJson(
        this.file(ctx),
        (data) => {
          data.version ??= 1;
          data.hooks ??= {};
          const ours = { command: hookCommand(ctx.node, ctx.loc.hook, 'cursor'), timeout: 30, matcher: MAYBE_INSTALL.source };
          data.hooks.beforeShellExecution = [...withoutOurs(data.hooks.beforeShellExecution, false), ours];
        },
        ctx,
      );
    },
    configured: (ctx) => jsonHas(path.join(ctx.home, '.cursor', 'hooks.json'), (d) => d.hooks?.beforeShellExecution, false),
    uninstall(ctx) {
      return editJson(this.file(ctx), (data) => prune(data, ['hooks', 'beforeShellExecution'], false), ctx);
    },
    selfTest: { agent: 'cursor', input: (command, cwd) => ({ hook_event_name: 'beforeShellExecution', command, cwd }) },
    next: 'Restart Cursor so it loads the new hook.',
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    file: (ctx) => path.join(ctx.home, '.codex', 'hooks.json'),
    present: (ctx) => Boolean(ctx.which('codex')) || fs.existsSync(path.join(ctx.home, '.codex')),
    where: (ctx) => `${ctx.show(path.join(ctx.home, '.codex', 'hooks.json'))} (PreToolUse on Bash)`,
    install(ctx) {
      return editJson(
        this.file(ctx),
        (data) => {
          data.hooks ??= {};
          const ours = {
            matcher: '^Bash$',
            hooks: [{ type: 'command', command: hookCommand(ctx.node, ctx.loc.hook, 'codex'), timeout: 30, statusMessage: 'pkgguard: checking packages' }],
          };
          data.hooks.PreToolUse = [...withoutOurs(data.hooks.PreToolUse, true), ours];
        },
        ctx,
      );
    },
    configured: (ctx) => jsonHas(path.join(ctx.home, '.codex', 'hooks.json'), (d) => d.hooks?.PreToolUse, true),
    uninstall(ctx) {
      return editJson(this.file(ctx), (data) => prune(data, ['hooks', 'PreToolUse'], true), ctx);
    },
    selfTest: { agent: 'codex', input: (command, cwd) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd }) },
    next: 'In Codex, run /hooks and trust the pkgguard hook; Codex does not run new hooks until you do.',
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    file: (ctx) => path.join(ctx.home, '.gemini', 'settings.json'),
    present: (ctx) => Boolean(ctx.which('gemini')) || fs.existsSync(path.join(ctx.home, '.gemini')),
    where: (ctx) => `${ctx.show(path.join(ctx.home, '.gemini', 'settings.json'))} (BeforeTool on run_shell_command)`,
    install(ctx) {
      return editJson(
        this.file(ctx),
        (data) => {
          data.hooks ??= {};
          const ours = {
            matcher: 'run_shell_command',
            hooks: [{ name: 'pkgguard', type: 'command', command: hookCommand(ctx.node, ctx.loc.hook, 'gemini'), timeout: 30000, description: 'Checks packages before they are installed' }],
          };
          data.hooks.BeforeTool = [...withoutOurs(data.hooks.BeforeTool, true), ours];
        },
        ctx,
      );
    },
    configured: (ctx) => jsonHas(path.join(ctx.home, '.gemini', 'settings.json'), (d) => d.hooks?.BeforeTool, true),
    uninstall(ctx) {
      return editJson(this.file(ctx), (data) => prune(data, ['hooks', 'BeforeTool'], true), ctx);
    },
    selfTest: { agent: 'gemini', input: (command, cwd) => ({ hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command }, cwd }) },
  },
  {
    id: 'shell',
    label: 'Your shell',
    present: (ctx) => Boolean(userShell(ctx.env)),
    where: (ctx) => {
      const shell = userShell(ctx.env);
      return `${ctx.show(rcFile(shell, ctx))} (${shell}: npm, pip and friends you type)`;
    },
    install(ctx) {
      const shell = userShell(ctx.env);
      const script = shellScript(shell, { node: ctx.node, cli: ctx.loc.cli });
      if (shell === 'fish') {
        const file = rcFile('fish', ctx);
        if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === script) return { changed: false };
        if (!ctx.dryRun) writeFile(file, script);
        return { changed: true };
      }
      const scriptFile = path.join(ctx.loc.base, `shell.${shell}`);
      const rc = rcFile(shell, ctx);
      const current = fs.existsSync(rc) ? fs.readFileSync(rc, 'utf8') : '';
      const next = withRcBlock(current, rcBlock(scriptFile));
      const scriptSame = fs.existsSync(scriptFile) && fs.readFileSync(scriptFile, 'utf8') === script;
      if (next === current && scriptSame) return { changed: false };
      if (!ctx.dryRun) {
        fs.mkdirSync(ctx.loc.base, { recursive: true });
        fs.writeFileSync(scriptFile, script);
        if (next !== current) writeFile(rc, next);
      }
      return { changed: true };
    },
    configured: (ctx) => {
      const shell = userShell(ctx.env);
      if (!shell) return null;
      const rc = rcFile(shell, ctx);
      if (!fs.existsSync(rc)) return false;
      return shell === 'fish' ? fs.readFileSync(rc, 'utf8').includes('__pkgguard_run') : fs.readFileSync(rc, 'utf8').includes(BLOCK_START);
    },
    uninstall(ctx) {
      let changed = false;
      for (const shell of SHELLS) {
        const rc = rcFile(shell, ctx);
        if (!fs.existsSync(rc)) continue;
        const text = fs.readFileSync(rc, 'utf8');
        if (shell === 'fish') {
          if (!text.includes('__pkgguard_run')) continue;
          if (!ctx.dryRun) fs.rmSync(rc);
          changed = true;
        } else if (text.includes(BLOCK_START)) {
          const rest = withoutRcBlock(text);
          if (!ctx.dryRun) writeOrRemove(rc, rest, !rest.trim());
          changed = true;
        }
      }
      return { changed };
    },
    next: 'Open a new terminal (or source your shell startup file) to turn it on.',
  },
];

function jsonHas(file, pick, nested) {
  if (!fs.existsSync(file)) return false;
  try {
    const list = pick(JSON.parse(fs.readFileSync(file, 'utf8'))) ?? [];
    return nested ? list.some((g) => (g?.hooks ?? []).some((h) => isOurs(h?.command))) : list.some((h) => isOurs(h?.command));
  } catch {
    return false;
  }
}

// Removes pkgguard from data[a][b], then drops what became empty.
function prune(data, [a, b], nested) {
  if (!data[a] || !Array.isArray(data[a][b])) return;
  const kept = withoutOurs(data[a][b], nested);
  if (kept.length) data[a][b] = kept;
  else delete data[a][b];
  if (!Object.keys(data[a]).length) delete data[a];
}

// The node to write into hooks. Homebrew runs node from a versioned Cellar
// path that disappears on the next upgrade; when the node on PATH is the same
// file (/opt/homebrew/bin/node), that stable name survives upgrades.
export function stableNode(execPath, env = process.env) {
  const onPath = which('node', env);
  try {
    if (onPath && fs.realpathSync(onPath) === fs.realpathSync(execPath)) return onPath;
  } catch {}
  return execPath;
}

export function context({ home = os.homedir(), env = process.env, node, run, dryRun = false } = {}) {
  node ??= stableNode(process.execPath, env);
  const loc = locations({ home, env });
  return {
    home,
    env,
    node,
    loc,
    dryRun,
    which: (bin) => which(bin, env),
    run: run ?? ((cmd, args) => {
      const r = spawnSync(cmd, args, { encoding: 'utf8', env, timeout: 120_000 });
      return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error?.message ?? '') };
    }),
    show: (file) => (file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file),
  };
}

// Copies the checking code to ~/.pkgguard/app so hooks keep working after
// npx clears its cache. A fresh copy replaces the old one in one rename.
export function installApp(ctx, source = SKILL_ROOT) {
  if (path.resolve(source) === path.resolve(ctx.loc.app)) return { changed: false };
  if (ctx.dryRun) return { changed: true };
  fs.mkdirSync(ctx.loc.base, { recursive: true });
  const staging = `${ctx.loc.app}.staging-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  for (const part of ['SKILL.md', 'scripts', 'data']) {
    fs.cpSync(path.join(source, part), path.join(staging, part), { recursive: true });
  }
  fs.writeFileSync(path.join(staging, 'VERSION'), `${VERSION}\n`);
  const old = `${ctx.loc.app}.old-${process.pid}`;
  if (fs.existsSync(ctx.loc.app)) fs.renameSync(ctx.loc.app, old);
  fs.renameSync(staging, ctx.loc.app);
  fs.rmSync(old, { recursive: true, force: true });
  return { changed: true };
}

export function installedVersion(ctx) {
  try {
    return fs.readFileSync(path.join(ctx.loc.app, 'VERSION'), 'utf8').trim();
  } catch {
    return null;
  }
}

// Runs one agent's hook on a command that must be blocked and reports
// whether the agent would have been stopped.
export function selfTest(ctx, target, { command = 'npm install expresss', node = ctx.node } = {}) {
  if (!target.selfTest) return null;
  const input = JSON.stringify(target.selfTest.input(command, ctx.home));
  const r = spawnSync(node, [ctx.loc.hook, '--agent', target.selfTest.agent], {
    input,
    encoding: 'utf8',
    env: { ...ctx.env, PKGGUARD_NO_CACHE: '1' },
    timeout: 60_000,
  });
  if (r.error || r.status !== 0) return { ok: false, detail: (r.stderr || r.error?.message || `exit ${r.status}`).trim() };
  let out = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    return { ok: false, detail: r.stdout.trim() ? `unexpected output: ${r.stdout.trim().slice(0, 120)}` : 'the hook let it through (offline?)' };
  }
  const denied =
    out?.hookSpecificOutput?.permissionDecision === 'deny' || out?.decision === 'deny' || out?.permission === 'deny';
  return denied ? { ok: true } : { ok: false, detail: `the hook answered ${JSON.stringify(out).slice(0, 120)}` };
}
