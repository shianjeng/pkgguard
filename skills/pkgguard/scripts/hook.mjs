#!/usr/bin/env node
// Claude Code PreToolUse hook for the Bash tool. Checks packages named in
// install commands and denies (BLOCK) or asks the user (WARN). It never
// approves anything on its own: clean installs fall through to the normal
// permission flow. Any failure inside the hook lets the command through.
//
// PKGGUARD_ON_WARN=ask|deny|allow changes what happens on WARN (default ask).
import { MAYBE_INSTALL } from './lib/parse.mjs';

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function decide(decision, reason) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason },
    })}\n`,
  );
}

try {
  const input = JSON.parse(await readStdin());
  const command = input?.tool_input?.command;
  if (input?.tool_name === 'Bash' && typeof command === 'string' && MAYBE_INSTALL.test(command)) {
    const { findInstalls } = await import('./lib/parse.mjs');
    const packages = findInstalls(command);
    if (packages.length) {
      const { checkAll } = await import('./lib/check.mjs');
      const { overall, renderResults } = await import('./lib/report.mjs');
      const results = await checkAll(packages);
      const verdict = overall(results);
      const text = renderResults(results);
      if (verdict === 'block') {
        decide('deny', text);
      } else if (verdict === 'warn') {
        const onWarn = process.env.PKGGUARD_ON_WARN ?? 'ask';
        if (onWarn === 'deny' || onWarn === 'ask') decide(onWarn, text);
      }
    }
  }
} catch (err) {
  process.stderr.write(`pkgguard hook skipped: ${err.message}\n`);
  process.exitCode = 1;
}
