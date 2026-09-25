// Finds the packages a shell command would install or execute.
// Only explicit names count: `npm install` with no arguments installs from
// the lockfile and is left alone.

const OPERATORS = new Set([';', '&&', '||', '|', '&', '(', ')', '\n']);

export function tokenize(command) {
  const segments = [[]];
  let token = null;
  let quote = null;
  const push = () => {
    if (token !== null) segments.at(-1).push(token);
    token = null;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else token += ch;
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
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      push();
      segments.push([]);
      i++;
      continue;
    }
    if (OPERATORS.has(ch)) {
      push();
      segments.push([]);
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      push();
      continue;
    }
    token = (token ?? '') + ch;
  }
  push();
  return segments.filter((s) => s.length);
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(['sudo', 'env', 'time', 'nice', 'nohup', 'command', 'exec', 'doas']);
const WRAPPER_VALUE_FLAGS = new Set(['-u', '-g', '-n', '-C', '-h', '-p', '-U']);

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
  '--node-options', '--loglevel',
]);
const PY_VALUE_FLAGS = new Set([
  '-r', '--requirement', '-c', '--constraint', '-e', '--editable', '-i', '--index-url', '--extra-index-url',
  '-f', '--find-links', '-t', '--target', '--prefix', '--root', '--platform', '--python-version',
  '--implementation', '--abi', '--src', '--upgrade-strategy', '--progress-bar', '--log', '--proxy',
  '--retries', '--timeout', '--trusted-host', '--cert', '--client-cert', '--cache-dir', '--python', '-p',
  '--group', '-G', '--source', '--extra', '-E', '--index', '--default-index', '--optional', '--dev-group',
  '--directory', '--project', '--package', '--with', '--python-platform', '--spec', '--pip-args', '--suffix',
  '--global', '--interpreter', '--allow-insecure-host',
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

const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const EXACT_VERSION = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export function parseNpmSpec(spec) {
  let s = spec.trim();
  if (!s || /^(\.|\/|~|file:|link:|workspace:|portal:|patch:|git\+|git:|https?:|github:|gitlab:|bitbucket:)/.test(s)) return null;
  if (/\.(tgz|tar\.gz)$/.test(s)) return null;
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

function detectNode(program, args) {
  const specs = [];
  const sub = args[0];
  const rest = args.slice(1);
  if (program === 'npx' || program === 'pnpx' || program === 'bunx') {
    const packages = flagValues(args, new Set(['-p', '--package']));
    if (packages.length) return packages;
    const first = firstPositional(args, NODE_VALUE_FLAGS);
    return first ? [first] : [];
  }
  if (program === 'npm' || program === 'cnpm') {
    if (NPM_INSTALL.has(sub)) specs.push(...positionals(rest, NODE_VALUE_FLAGS));
    else if (sub === 'exec' || sub === 'x') {
      const packages = flagValues(rest, new Set(['-p', '--package']));
      specs.push(...(packages.length ? packages : [firstPositional(rest, NODE_VALUE_FLAGS)].filter(Boolean)));
    }
    return specs;
  }
  if (program === 'pnpm') {
    if (sub === 'add' || sub === 'install' || sub === 'i') specs.push(...positionals(rest, NODE_VALUE_FLAGS));
    else if (sub === 'dlx') specs.push(...[firstPositional(rest, NODE_VALUE_FLAGS)].filter(Boolean));
    return specs;
  }
  if (program === 'yarn') {
    if (sub === 'add') specs.push(...positionals(rest, NODE_VALUE_FLAGS));
    else if (sub === 'global' && rest[0] === 'add') specs.push(...positionals(rest.slice(1), NODE_VALUE_FLAGS));
    else if (sub === 'dlx') specs.push(...[firstPositional(rest, NODE_VALUE_FLAGS)].filter(Boolean));
    return specs;
  }
  if (program === 'bun') {
    if (sub === 'add' || sub === 'a' || sub === 'install' || sub === 'i') specs.push(...positionals(rest, NODE_VALUE_FLAGS));
    else if (sub === 'x') specs.push(...[firstPositional(rest, NODE_VALUE_FLAGS)].filter(Boolean));
    return specs;
  }
  return specs;
}

function detectPython(program, args) {
  if (/^python(\d+(\.\d+)?)?$/.test(program)) {
    const m = args.indexOf('-m');
    if (m === -1 || args[m + 1] !== 'pip') return [];
    return detectPython('pip', args.slice(m + 2));
  }
  const sub = args[0];
  const rest = args.slice(1);
  if (/^pip(\d+(\.\d+)?)?$/.test(program)) return sub === 'install' ? positionals(rest, PY_VALUE_FLAGS) : [];
  if (program === 'uv') {
    if (sub === 'pip' && rest[0] === 'install') return positionals(rest.slice(1), PY_VALUE_FLAGS);
    if (sub === 'add') return positionals(rest, PY_VALUE_FLAGS);
    if (sub === 'tool' && (rest[0] === 'install' || rest[0] === 'run')) {
      const from = flagValues(rest.slice(1), new Set(['--from']));
      return from.length ? from : [firstPositional(rest.slice(1), PY_VALUE_FLAGS)].filter(Boolean);
    }
    return [];
  }
  if (program === 'uvx') {
    const from = flagValues(args, new Set(['--from']));
    return from.length ? from : [firstPositional(args, PY_VALUE_FLAGS)].filter(Boolean);
  }
  if (program === 'pipx') {
    if (sub === 'install') return positionals(rest, PY_VALUE_FLAGS);
    if (sub === 'run') {
      const spec = flagValues(rest, new Set(['--spec']));
      return spec.length ? spec : [firstPositional(rest, PY_VALUE_FLAGS)].filter(Boolean);
    }
    return [];
  }
  if (program === 'poetry' || program === 'pdm' || program === 'rye') return sub === 'add' ? positionals(rest, PY_VALUE_FLAGS) : [];
  return [];
}

const NODE_PROGRAMS = new Set(['npm', 'cnpm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx']);

export function findInstalls(command) {
  const found = [];
  const seen = new Set();
  for (const segment of tokenize(String(command ?? ''))) {
    const tokens = unwrap(segment);
    if (!tokens.length) continue;
    const program = basename(tokens[0]);
    const args = tokens.slice(1);
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
  return found;
}

// Cheap pre-check so the hook can skip the vast majority of shell commands.
export const MAYBE_INSTALL = /\b(npm|cnpm|npx|pnpm|pnpx|yarn|bunx?|pip\d*(\.\d+)?|pipx|uvx?|poetry|pdm|rye|python\d*(\.\d+)?)\b/;
