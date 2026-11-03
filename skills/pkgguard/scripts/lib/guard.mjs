// `pkgguard guard npm install x`: the check behind the shell functions, for a
// person at a terminal rather than an agent.
//
// Exit codes, which the shell functions act on:
//   0  run the command (nothing found, OK, or the user said yes to a warning)
//   2  blocked
//   3  the user said no to a warning, or there was no terminal to ask
//   anything else: pkgguard itself failed; the shell function runs the command anyway
import fs from 'node:fs';
import { openCache } from './cache.mjs';
import { inspectCommand } from './inspect.mjs';
import { MAYBE_INSTALL } from './parse.mjs';
import { renderResults } from './report.mjs';

export function shellQuote(word) {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${String(word).replace(/'/g, `'\\''`)}'`;
}

// Reads one line from the terminal, even when stdin is a pipe. PKGGUARD_TTY
// points it at another file, which is how the tests answer.
export function askTerminal(question, { stderr, ttyPath }) {
  let fd;
  try {
    fd = fs.openSync(ttyPath, 'r');
  } catch {
    return null;
  }
  stderr.write(question);
  const buf = Buffer.alloc(1);
  let answer = '';
  let line = false;
  try {
    while (fs.readSync(fd, buf, 0, 1, null) === 1) {
      if (buf[0] === 10) {
        line = true;
        break;
      }
      answer += String.fromCharCode(buf[0]);
    }
  } finally {
    fs.closeSync(fd);
  }
  // End of input before a line is not an answer: nobody pressed Enter, so
  // neither a default "yes" nor any other reply may be assumed.
  if (!line && !answer.trim()) return null;
  return answer.trim();
}

function okLine(found) {
  const names = found.results.filter((r) => !r.locked).map((r) => r.name);
  const parts = [];
  if (names.length) parts.push(`${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}`);
  for (const note of found.notes) {
    const m = /^(?:All (\d+) packages|The (1) package) pinned in (\S+)/.exec(note.text);
    if (m) parts.push(`${m[1] ?? m[2]} packages in ${m[3]}`);
  }
  return `pkgguard ✓ ${parts.join(', ') || 'nothing suspicious'}\n`;
}

export async function guard(words, { cwd = process.cwd(), env = process.env, stderr = process.stderr, fetchImpl } = {}) {
  const command = words.map(shellQuote).join(' ');
  if (!MAYBE_INSTALL.test(command)) return 0;
  const found = await inspectCommand(command, cwd, { cache: env.PKGGUARD_NO_CACHE ? null : openCache(env), fetchImpl, env });
  if (!found) return 0;
  const color = Boolean(stderr.isTTY) && !('NO_COLOR' in env);

  if (found.verdict !== 'block' && found.verdict !== 'warn') {
    if (!env.PKGGUARD_QUIET) stderr.write(color ? `\x1b[2m${okLine(found)}\x1b[0m` : okLine(found));
    return 0;
  }

  stderr.write(renderResults(found.results, { notes: found.notes, audience: 'human', color, command }));
  if (found.verdict === 'block') return 2;

  const onWarn = env.PKGGUARD_ON_WARN ?? 'ask';
  if (onWarn === 'allow') return 0;
  if (onWarn === 'deny') return 3;
  const answer = askTerminal('Install anyway? [y/N] ', { stderr, ttyPath: env.PKGGUARD_TTY || '/dev/tty' });
  if (answer === null) {
    stderr.write('No terminal to ask, so it was not installed. Set PKGGUARD_ON_WARN=allow to install warned packages without asking.\n');
    return 3;
  }
  return /^y(es)?$/i.test(answer) ? 0 : 3;
}
