// Finds the packages a shell command would install or execute.
// Only explicit names count: `npm install` with no arguments installs from
// the lockfile and is left alone.

const OPERATORS = new Set([';', '&', '|', '(', ')']);
const MAX_DEPTH = 5;

// Splits a command into simple commands (arrays of words). Redirection
// targets and here-document bodies are dropped, and the bodies of `$(...)`
// and backquote substitutions are returned separately so they can be scanned
// as commands of their own.
function scan(command) {
  const segments = [[]];
  const nested = [];
  const heredocs = [];
  let token = null;
  let quote = null;
  let skipWord = false;

  const push = () => {
    if (token !== null) {
      if (skipWord) skipWord = false;
      else segments.at(-1).push(token);
    }
    token = null;
  };
  const split = () => {
    push();
    skipWord = false;
    segments.push([]);
  };
  const substitutionEnd = (start, closer) => {
    if (closer === '`') {
      const end = command.indexOf('`', start);
      return end === -1 ? command.length : end;
    }
    let depth = 1;
    let q = null;
    for (let j = start; j < command.length; j++) {
      const c = command[j];
      if (q) {
        if (c === q) q = null;
        else if (c === '\\' && q === '"') j++;
      } else if (c === "'" || c === '"') q = c;
      else if (c === '\\') j++;
      else if (c === '(') depth++;
      else if (c === ')' && --depth === 0) return j;
    }
    return command.length;
  };
  const skipHeredocBodies = (newline) => {
    let j = newline + 1;
    while (heredocs.length) {
      const { delimiter, stripTabs } = heredocs.shift();
      while (j < command.length) {
        const nl = command.indexOf('\n', j);
        const end = nl === -1 ? command.length : nl;
        const line = stripTabs ? command.slice(j, end).replace(/^\t+/, '') : command.slice(j, end);
        j = end + 1;
        if (line === delimiter) break;
      }
    }
    return j - 1;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else token += ch;
      continue;
    }
    if (ch === '`' || (ch === '$' && command[i + 1] === '(')) {
      const open = ch === '`' ? i + 1 : i + 2;
      const end = substitutionEnd(open, ch === '`' ? '`' : ')');
      nested.push(command.slice(open, end));
      token = `${token ?? ''}\0`; // the word exists, but its value is unknown
      i = end;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && i + 1 < command.length && '"\\$`'.includes(command[i + 1])) token += command[++i];
      else token += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      token ??= '';
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      const next = command[++i];
      if (next !== '\n') token = (token ?? '') + next;
      continue;
    }
    if (ch === '#' && token === null) {
      while (i + 1 < command.length && command[i + 1] !== '\n') i++;
      continue;
    }
    if (ch === '>' || ch === '<' || (ch === '&' && command[i + 1] === '>')) {
      if (token !== null && /^\d+$/.test(token)) token = null; // "2>" names a file descriptor
      push();
      let j = ch === '&' ? i + 1 : i;
      const op = command[j++];
      if (op === '<' && command[j] === '<') {
        j++;
        if (command[j] === '<') {
          skipWord = true; // <<< here-string
          i = j;
          continue;
        }
        const stripTabs = command[j] === '-';
        if (stripTabs) j++;
        while (command[j] === ' ' || command[j] === '\t') j++;
        const m = /^(['"]?)([^\s'"<>;&|()]+)\1/.exec(command.slice(j));
        if (m) {
          heredocs.push({ delimiter: m[2], stripTabs });
          j += m[0].length;
        }
        i = j - 1;
        continue;
      }
      if (command[j] === '>' || command[j] === '|') j++;
      if (command[j] === '&') {
        j++; // >&2, 2>&1, <&- duplicate a descriptor and take no word
        while (/[0-9-]/.test(command[j] ?? '')) j++;
      } else {
        skipWord = true;
      }
      i = j - 1;
      continue;
    }
    if (ch === '\n') {
      split();
      if (heredocs.length) i = skipHeredocBodies(i);
      continue;
    }
    if ((ch === '&' || ch === '|') && command[i + 1] === ch) {
      split();
      i++;
      continue;
    }
    if (OPERATORS.has(ch)) {
      split();
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      push();
      continue;
    }
    token = (token ?? '') + ch;
  }
  push();
  return { segments: segments.filter((s) => s.length), nested };
}

export function tokenize(command) {
  return scan(command).segments;
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(['sudo', 'env', 'time', 'nice', 'nohup', 'command', 'exec', 'doas']);
const WRAPPER_VALUE_FLAGS = new Set(['-u', '-g', '-n', '-C', '-h', '-p', '-U']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);

function unwrap(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (ENV_ASSIGNMENT.test(t)) {
      i++;
    } else if (WRAPPERS.has(basename(t))) {
      i++;
      while (i < tokens.length && tokens[i].startsWith('-')) {
        if (WRAPPER_VALUE_FLAGS.has(tokens[i])) i++;
        i++;
      }
    } else {
      break;
    }
  }
  return tokens.slice(i);
}

function basename(path) {
  return path.split(/[\\/]/).pop().replace(/\.(exe|cmd)$/i, '');
}

// Flags whose value is the next token. `--flag=value` is handled generically.
const NODE_VALUE_FLAGS = new Set([
  '--registry', '--prefix', '-w', '--workspace', '--tag', '--save-prefix', '--cache', '--userconfig',
  '--omit', '--include', '-C', '--dir', '--filter', '-F', '--cwd', '--otp', '--scope', '--config',
  '--network-concurrency', '--cpu', '--os', '--libc', '--reporter', '--backend', '--shell', '--call', '-c',
  '--node-options', '--loglevel', '--import-map', '--lock', '--cert', '--location', '--env-file', '--root',
]);
const PY_VALUE_FLAGS = new Set([
  '-r', '--requirement', '-c', '--constraint', '-e', '--editable', '-i', '--index-url', '--extra-index-url',
  '-f', '--find-links', '-t', '--target', '--prefix', '--root', '--platform', '--python-version',
  '--implementation', '--abi', '--src', '--upgrade-strategy', '--progress-bar', '--log', '--proxy',
  '--retries', '--timeout', '--trusted-host', '--cert', '--client-cert', '--cache-dir', '--python', '-p',
  '--group', '-G', '--source', '--extra', '-E', '--index', '--default-index', '--optional', '--dev-group',
  '--directory', '--project', '--package', '--with', '--python-platform', '--spec', '--pip-args', '--suffix',
  '--global', '--interpreter', '--allow-insecure-host', '-C', '--config-settings', '--config-file',
]);

function positionals(args, valueFlags) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      out.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith('-')) {
      if (!arg.includes('=') && valueFlags.has(arg)) i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function flagValues(args, names) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const eq = arg.indexOf('=');
    if (eq !== -1 && names.has(arg.slice(0, eq))) out.push(arg.slice(eq + 1));
    else if (names.has(arg) && i + 1 < args.length) out.push(args[++i]);
  }
  return out;
}

// Only the first positional names a package in `npx foo --bar`; the rest are its arguments.
function firstPositional(args, valueFlags) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') return args[i + 1] ?? null;
    if (arg.startsWith('-')) {
      if (!arg.includes('=') && valueFlags.has(arg)) i++;
      continue;
    }
    return arg;
  }
  return null;
}

// Skips global options that come before the subcommand: `npm -g install x`,
// `pnpm -C web add x`, `pip -q install x`.
function subcommand(args, valueFlags) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-') && args[i] !== '--') {
    if (!args[i].includes('=') && valueFlags.has(args[i])) i++;
    i++;
  }
  return { sub: args[i], rest: args.slice(i + 1) };
}

// Scopes are lowercase; unscoped names from before 2017 may contain capitals (JSONStream).
const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/[a-z0-9-~][a-z0-9-._~]*|[A-Za-z0-9-~][A-Za-z0-9-._~]*)$/;
const EXACT_VERSION = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export function parseNpmSpec(spec) {
  let s = spec.trim();
  if (!s || /^(\.|\/|~|file:|link:|workspace:|portal:|patch:|git\+|git:|https?:|github:|gitlab:|bitbucket:|jsr:)/.test(s)) return null;
  if (/\.(tgz|tar\.gz)$/.test(s)) return null;
  s = s.replace(/^npm:/, '');
  const alias = /^[^@]+@npm:(.+)$/.exec(s) ?? /^@[^/]+\/[^@]+@npm:(.+)$/.exec(s);
  if (alias) s = alias[1];
  const at = s.lastIndexOf('@');
  const name = at > 0 ? s.slice(0, at) : s;
  const requested = at > 0 ? s.slice(at + 1) : null;
  if (!name.startsWith('@') && name.includes('/')) return null; // github shorthand user/repo
  if (!NPM_NAME.test(name)) return null;
  return {
    ecosystem: 'npm',
    name,
    requested: requested || null,
    version: requested && EXACT_VERSION.test(requested) ? requested.replace(/^v/, '') : null,
  };
}

export function normalizePyName(name) {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

export function parsePySpec(spec) {
  const s = spec.trim().split(';')[0].trim();
  if (!s || /^(\.|\/|~|git\+|https?:|file:|[a-zA-Z]:\\)/.test(s)) return null;
  if (/\.(whl|tar\.gz|zip|tgz)$/i.test(s) || s.includes('/') || /\s@\s/.test(spec)) return null;
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(\[[^\]]*\])?\s*(.*)$/.exec(s);
  if (!match) return null;
  const constraint = match[3].trim();
  const exact = /^===?\s*([A-Za-z0-9.+!-]+)$/.exec(constraint);
  return {
    ecosystem: 'pypi',
    name: normalizePyName(match[1]),
    requested: constraint || null,
    version: exact && !exact[1].includes('*') ? exact[1] : null,
  };
}

const NPM_INSTALL = new Set(['install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'add']);
const one = (value) => (value ? [value] : []);

function detectNode(program, args) {
  if (program === 'npx' || program === 'pnpx' || program === 'bunx') {
    const packages = flagValues(args, new Set(['-p', '--package']));
    return packages.length ? packages : one(firstPositional(args, NODE_VALUE_FLAGS));
  }
  const { sub, rest } = subcommand(args, NODE_VALUE_FLAGS);
  if (program === 'npm' || program === 'cnpm') {
    if (NPM_INSTALL.has(sub)) return positionals(rest, NODE_VALUE_FLAGS);
    if (sub === 'exec' || sub === 'x') {
      const packages = flagValues(rest, new Set(['-p', '--package']));
      return packages.length ? packages : one(firstPositional(rest, NODE_VALUE_FLAGS));
    }
    return [];
  }
  if (program === 'pnpm') {
    if (sub === 'add' || sub === 'install' || sub === 'i') return positionals(rest, NODE_VALUE_FLAGS);
    if (sub === 'dlx') return one(firstPositional(rest, NODE_VALUE_FLAGS));
    return [];
  }
  if (program === 'yarn') {
    if (sub === 'add') return positionals(rest, NODE_VALUE_FLAGS);
    if (sub === 'global' && rest[0] === 'add') return positionals(rest.slice(1), NODE_VALUE_FLAGS);
    if (sub === 'dlx') return one(firstPositional(rest, NODE_VALUE_FLAGS));
    return [];
  }
  if (program === 'bun') {
    if (sub === 'add' || sub === 'a' || sub === 'install' || sub === 'i') return positionals(rest, NODE_VALUE_FLAGS);
    if (sub === 'x') return one(firstPositional(rest, NODE_VALUE_FLAGS));
    return [];
  }
  if (program === 'deno') {
    // Deno only reaches npm through explicit npm: specifiers.
    const specs = sub === 'run' || sub === 'x' ? one(firstPositional(rest, NODE_VALUE_FLAGS)) : ['add', 'install', 'i'].includes(sub) ? positionals(rest, NODE_VALUE_FLAGS) : [];
    return specs.filter((s) => s.startsWith('npm:'));
  }
  return [];
}

function detectPython(program, args) {
  if (/^python(\d+(\.\d+)?)?$/.test(program)) {
    const m = args.indexOf('-m');
    if (m === -1 || args[m + 1] !== 'pip') return [];
    return detectPython('pip', args.slice(m + 2));
  }
  if (program === 'uvx') {
    const from = flagValues(args, new Set(['--from']));
    return from.length ? from : one(firstPositional(args, PY_VALUE_FLAGS));
  }
  const { sub, rest } = subcommand(args, PY_VALUE_FLAGS);
  if (/^pip(\d+(\.\d+)?)?$/.test(program)) return sub === 'install' ? positionals(rest, PY_VALUE_FLAGS) : [];
  if (program === 'uv') {
    if (sub === 'pip' && rest[0] === 'install') return positionals(rest.slice(1), PY_VALUE_FLAGS);
    if (sub === 'add') return positionals(rest, PY_VALUE_FLAGS);
    if (sub === 'tool' && (rest[0] === 'install' || rest[0] === 'run')) {
      const from = flagValues(rest.slice(1), new Set(['--from']));
      return from.length ? from : one(firstPositional(rest.slice(1), PY_VALUE_FLAGS));
    }
    return [];
  }
  if (program === 'pipx') {
    if (sub === 'install') return positionals(rest, PY_VALUE_FLAGS);
    if (sub === 'run') {
      const spec = flagValues(rest, new Set(['--spec']));
      return spec.length ? spec : one(firstPositional(rest, PY_VALUE_FLAGS));
    }
    return [];
  }
  if (program === 'poetry' || program === 'pdm' || program === 'rye') return sub === 'add' ? positionals(rest, PY_VALUE_FLAGS) : [];
  return [];
}

const NODE_PROGRAMS = new Set(['npm', 'cnpm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx', 'deno']);

function collect(command, found, seen, depth) {
  if (depth > MAX_DEPTH) return;
  const { segments, nested } = scan(command);
  for (const inner of nested) collect(inner, found, seen, depth + 1);
  for (const segment of segments) {
    const tokens = unwrap(segment);
    if (!tokens.length) continue;
    const program = basename(tokens[0]);
    const args = tokens.slice(1);

    // bash -c "npm i x", bash -lc '...', eval "..."
    if (SHELLS.has(program)) {
      const flag = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
      if (flag !== -1 && args[flag + 1] !== undefined) collect(args[flag + 1], found, seen, depth + 1);
      continue;
    }
    if (program === 'eval') {
      collect(args.join(' '), found, seen, depth + 1);
      continue;
    }

    const isNode = NODE_PROGRAMS.has(program);
    const specs = isNode ? detectNode(program, args) : detectPython(program, args);
    for (const spec of specs) {
      const pkg = isNode ? parseNpmSpec(spec) : parsePySpec(spec);
      if (!pkg) continue;
      const key = `${pkg.ecosystem}:${pkg.name}@${pkg.requested ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ ...pkg, spec });
    }
  }
}

export function findInstalls(command) {
  const found = [];
  collect(String(command ?? ''), found, new Set(), 0);
  return found;
}

// Cheap pre-check so the hook can skip the vast majority of shell commands.
export const MAYBE_INSTALL = /\b(npm|cnpm|npx|pnpm|pnpx|yarn|bunx?|deno|pip\d*(\.\d+)?|pipx|uvx?|poetry|pdm|rye|python\d*(\.\d+)?)\b/;
