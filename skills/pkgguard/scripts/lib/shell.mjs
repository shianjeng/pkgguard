// Shell functions that put `pkgguard guard` in front of the package managers a
// person types, for zsh, bash and fish. They are defined only in interactive
// shells (they live in the startup file), so scripts and CI never see them.
// If pkgguard is missing or fails, the real command still runs.

export const WRAPPED = ['npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx', 'pip', 'pip3', 'uv', 'uvx', 'pipx', 'poetry', 'pdm'];
export const SHELLS = ['zsh', 'bash', 'fish'];

const single = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;
const fishQuote = (text) => `'${String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

const HEADER = (comment) =>
  [
    `${comment} pkgguard checks packages before npm, pip and friends install them.`,
    `${comment} Written by \`pkgguard init\`; \`pkgguard uninstall\` removes it.`,
    `${comment} Put PKGGUARD_OFF=1 in front of a command to skip the check once.`,
  ].join('\n');

export function shellScript(shell, { node, cli }) {
  if (shell === 'fish') {
    return `${HEADER('#')}
set -g __pkgguard_node ${fishQuote(node)}
set -g __pkgguard_cli ${fishQuote(cli)}

function __pkgguard_run
    if not set -q PKGGUARD_OFF
        if test -x $__pkgguard_node; and test -f $__pkgguard_cli
            $__pkgguard_node $__pkgguard_cli guard $argv
            set -l code $status
            if test $code -eq 2; or test $code -eq 3
                return 1
            else if test $code -ne 0
                echo "pkgguard: the check failed, running $argv[1] anyway" >&2
            end
        else
            echo "pkgguard: not found at $__pkgguard_cli; run pkgguard init again" >&2
        end
    end
    command $argv
end

${WRAPPED.map((tool) => `function ${tool} --wraps ${tool}\n    __pkgguard_run ${tool} $argv\nend`).join('\n')}
`;
  }
  // zsh and bash share one script. `function name { }` rather than `name() { }`
  // so an existing alias of the same name cannot break the definition.
  return `${HEADER('#')}
__pkgguard_node=${single(node)}
__pkgguard_cli=${single(cli)}

__pkgguard_run() {
  if [ -z "\${PKGGUARD_OFF-}" ]; then
    if [ -x "$__pkgguard_node" ] && [ -f "$__pkgguard_cli" ]; then
      "$__pkgguard_node" "$__pkgguard_cli" guard "$@"
      case $? in
        0) ;;
        2|3) return 1 ;;
        *) printf '%s\\n' "pkgguard: the check failed, running $1 anyway" >&2 ;;
      esac
    else
      printf '%s\\n' "pkgguard: not found at $__pkgguard_cli; run pkgguard init again" >&2
    fi
  fi
  command "$@"
}

${WRAPPED.map((tool) => `function ${tool} { __pkgguard_run ${tool} "$@"; }`).join('\n')}
`;
}

export const BLOCK_START = '# >>> pkgguard >>>';
export const BLOCK_END = '# <<< pkgguard <<<';

// The lines that go into ~/.zshrc or ~/.bashrc.
export function rcBlock(scriptFile) {
  return `${BLOCK_START}\n[ -f ${single(scriptFile)} ] && . ${single(scriptFile)}\n${BLOCK_END}\n`;
}

// Puts the block into an rc file's text, replacing an earlier one.
export function withRcBlock(text, block) {
  const cleaned = withoutRcBlock(text);
  return `${cleaned}${cleaned && !cleaned.endsWith('\n') ? '\n' : ''}${cleaned ? '\n' : ''}${block}`;
}

export function withoutRcBlock(text) {
  const start = text.indexOf(BLOCK_START);
  const end = text.indexOf(BLOCK_END);
  if (start === -1 || end === -1 || end < start) return text;
  const before = text.slice(0, start).replace(/\n*$/, start ? '\n' : '');
  const after = text.slice(end + BLOCK_END.length).replace(/^\n/, '');
  return `${before}${after}`;
}
