#!/usr/bin/env node
// Pre-command hook for coding agents. Checks the packages a shell command
// would install and denies (BLOCK) or asks the user (WARN). It never approves
// anything on its own: clean installs fall through to the agent's normal
// permission flow. Any failure inside the hook lets the command through.
//
//   hook.mjs                  Claude Code (PreToolUse on Bash)
//   hook.mjs --agent cursor   Cursor (beforeShellExecution)
//   hook.mjs --agent codex    Codex CLI (PreToolUse on Bash)
//   hook.mjs --agent gemini   Gemini CLI (BeforeTool on run_shell_command)
//
// PKGGUARD_ON_WARN=ask|deny|allow changes what happens on WARN. Codex and
// Gemini CLI cannot ask (an "ask" answer is ignored and the command runs), so
// there the default is deny.
import path from 'node:path';
import { MAYBE_INSTALL } from './lib/parse.mjs';

const AGENTS = {
  claude: {
    canAsk: true,
    read: (input) => input?.tool_name === 'Bash' && { command: input.tool_input?.command, cwd: input.cwd },
    write: (decision, text) => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: text },
    }),
  },
  codex: {
    canAsk: false,
    read: (input) =>
      (input?.tool_name === undefined || ['Bash', 'exec_command'].includes(input.tool_name)) && { command: input?.tool_input?.command, cwd: input?.cwd },
    write: (decision, text) => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: text },
    }),
  },
  gemini: {
    canAsk: false,
    read: (input) => {
      if (input?.tool_name !== 'run_shell_command') return false;
      const root = process.env.GEMINI_PROJECT_DIR || input.cwd;
      const dir = input.tool_input?.directory;
      return { command: input.tool_input?.command, cwd: dir && root ? path.resolve(root, dir) : input.cwd };
    },
    write: (decision, text, summary) => ({ decision: 'deny', reason: text, systemMessage: summary }),
  },
  cursor: {
    canAsk: true,
    read: (input) => ({ command: input?.command, cwd: input?.cwd }),
    write: (decision, text, summary) => ({ permission: decision, user_message: summary, agent_message: text }),
  },
};

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function agentName(argv) {
  const i = argv.indexOf('--agent');
  const name = i === -1 ? 'claude' : argv[i + 1];
  if (!AGENTS[name]) throw new Error(`unknown agent "${name}"; use claude, cursor, codex or gemini`);
  return name;
}

// One line for places that show the user a short message next to the agent's.
function summarize(verdict, results) {
  const flagged = results.filter((r) => r.verdict === 'block' || r.verdict === 'warn').map((r) => r.name);
  const which = flagged.length ? `: ${flagged.slice(0, 3).join(', ')}${flagged.length > 3 ? ', …' : ''}` : '';
  return verdict === 'block' ? `pkgguard blocked this install${which}` : `pkgguard has concerns about this install${which}`;
}

try {
  const agent = AGENTS[agentName(process.argv.slice(2))];
  const target = agent.read(JSON.parse(await readStdin()));
  if (target && typeof target.command === 'string' && MAYBE_INSTALL.test(target.command)) {
    const { openCache } = await import('./lib/cache.mjs');
    const { inspectCommand } = await import('./lib/inspect.mjs');
    const { renderResults } = await import('./lib/report.mjs');
    const cwd = typeof target.cwd === 'string' ? target.cwd : process.cwd();
    const found = await inspectCommand(target.command, cwd, { cache: openCache() });
    if (found && (found.verdict === 'block' || found.verdict === 'warn')) {
      let text = renderResults(found.results, { notes: found.notes });
      let decision = 'deny';
      if (found.verdict === 'warn') {
        decision = process.env.PKGGUARD_ON_WARN ?? (agent.canAsk ? 'ask' : 'deny');
        if (decision === 'ask' && !agent.canAsk) decision = 'deny';
        if (decision === 'deny' && !agent.canAsk) {
          text += 'This agent cannot ask the user to confirm, so pkgguard denied the command. If the user confirms, they can run it themselves.\n';
        }
      }
      if (decision === 'deny' || decision === 'ask') {
        process.stdout.write(`${JSON.stringify(agent.write(decision, text, summarize(found.verdict, found.results)))}\n`);
      }
    }
  }
} catch (err) {
  process.stderr.write(`pkgguard hook skipped: ${err.message}\n`);
  process.exitCode = 1;
}
