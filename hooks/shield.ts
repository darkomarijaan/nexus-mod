export type ShieldHit = { id: string; why: string }

type Rule = { id: string; why: string; re: RegExp }

/*
 * Rules read the whole command and each of its simple commands in a
 * canonical form (wrappers such as sudo, xargs or a /bin/ path removed, git's
 * global options dropped), so `git -C dir push --force` and `xargs rm -rf`
 * are judged like their plain spelling. Text a command only prints or
 * searches for (a commit message, a grep pattern) is left out first, so
 * `git commit -m "drop table docs"` does not trip the SQL rules.
 */
const RULES: Rule[] = [
  {
    id: 'win-recursive-delete',
    why: 'recursively deletes files',
    re: /\b(remove-item|ri|rmdir|rd|del|erase)\b[^;|&\n]*\s(-recurse\b|-r\b|\/s\b)/i,
  },
  { id: 'find-delete', why: 'deletes every file a search matches', re: /\bfind\b[^;|&\n]*\s-delete\b/ },
  {
    id: 'find-exec-rm',
    why: 'recursively deletes every match of a search',
    re: /\bfind\b[^|&\n]*\s-exec(dir)?\s+(\S*\/)?rm\s+(-\w*[rR]|--recursive)/,
  },
  {
    id: 'git-force-push',
    why: 'force-pushes, rewriting remote history',
    re: /\bgit\s+push\b[^;|&\n]*(\s--force(-with-lease)?\b|\s-f\b|\s\+[\w./-]+)/,
  },
  { id: 'git-reset-hard', why: 'discards uncommitted work (reset --hard)', re: /\bgit\s+reset\b[^;|&\n]*--hard\b/ },
  { id: 'git-clean', why: 'deletes untracked files (git clean)', re: /\bgit\s+clean\b[^;|&\n]*\s-[a-zA-Z]*f/ },
  {
    id: 'git-discard',
    why: 'discards uncommitted changes in the working tree',
    re: /\bgit\s+(checkout\s+(--\s+)?\.(\s|$)|restore\s+(?![^;|&\n]*--staged)[^;|&\n]*\.(\s|$))/,
  },
  { id: 'git-branch-delete', why: 'force-deletes a branch', re: /\bgit\s+branch\b[^;|&\n]*\s-D\b/ },
  { id: 'git-stash-drop', why: 'drops stashed work', re: /\bgit\s+stash\s+(drop|clear)\b/ },
  { id: 'git-history-rewrite', why: 'rewrites repository history', re: /\bgit\s+(filter-branch|filter-repo)\b/ },
  {
    id: 'sql-drop',
    why: 'drops a database object',
    re: /\bdrop\s+(table|database|schema|view|index|collection)\b/i,
  },
  { id: 'sql-truncate', why: 'empties a table (TRUNCATE)', re: /\btruncate\s+(table\s+)?[\w."`[\]]+/i },
  {
    // No /m: a WHERE on the next line belongs to the same statement.
    id: 'sql-delete-all',
    why: 'deletes every row of a table (DELETE with no WHERE)',
    re: /\bdelete\s+from\s+[\w."`[\]]+\s*(;|"|'|$)/i,
  },
  {
    id: 'db-reset',
    why: 'drops or resets a database',
    re: /\b(dropdb|prisma\s+migrate\s+reset|db:drop|db:reset|flushall|flushdb)\b/i,
  },
  { id: 'disk-format', why: 'formats or overwrites a disk', re: /\b(mkfs(\.\w+)?|diskpart|format-volume)\b|\bdd\b[^;|&\n]*\bof=\/dev\/|\bformat\s+[a-z]:/i },
  { id: 'fork-bomb', why: 'is a fork bomb', re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/ },
  {
    id: 'perm-root',
    why: 'changes permissions or ownership of the whole filesystem',
    re: /\b(chmod|chown)\s+(-R\s+)?\S+\s+\/(\s|$)/,
  },
  {
    id: 'pipe-to-shell',
    why: 'downloads and runs a remote script',
    re: /\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba|z|)sh\b|\b(iwr|irm|invoke-webrequest|invoke-restmethod)\b[^|\n]*\|\s*iex\b/i,
  },
  {
    id: 'infra-destroy',
    why: 'destroys infrastructure or containers',
    re: /\b(terraform\s+destroy|kubectl\s+delete|helm\s+uninstall|docker\s+(system|volume)\s+prune)\b/,
  },
  { id: 'publish', why: 'publishes a package publicly', re: /\b((npm|pnpm|yarn)\s+publish|cargo\s+publish|twine\s+upload)\b/ },
]

// Commands that only print or search: their arguments are text, not actions.
const TEXT_COMMANDS = /(^|[;&|\n(]\s*)((?:e|f)?grep|rg|ag|ack|findstr|select-string|sls)((?:\s+(?:"[^"\n]*"|'[^'\n]*'|[^\s;&|"'<>()]+))*)/gi
// Flags whose value is a message: a commit, a tag, a PR title or body.
const MESSAGE_FLAGS = /(\s(?:-m|--message|--title|--body|--subject|--notes|--grep)(?:\s+|=))("[^"\n]*"|'[^'\n]*')/g

/** Leaves out text a command only prints or searches for. Only whole quoted strings or tokens go, so nothing after them hides. */
function neutralize(command: string): string {
  return command.replace(MESSAGE_FLAGS, '$1""').replace(TEXT_COMMANDS, '$1$2')
}

/** Splits a shell line into simple commands at ; & && || | and newlines. Quotes are not honoured on purpose: a split too many only makes the shield stricter. */
function segments(command: string): string[] {
  return command
    .split(/\n|;|&&|\|\||\||(?<![>&])&(?![>&])/)
    .map(part => part.trim())
    .filter(Boolean)
}

/** `/usr/bin/RM.exe` → `rm`. */
function commandName(word: string): string {
  return (
    word
      .replace(/^["']|["']$/g, '')
      .split(/[\\/]/)
      .at(-1)
      ?.replace(/\.(exe|cmd|bat)$/i, '')
      .toLowerCase() ?? ''
  )
}

// Commands that run the command after them.
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'command', 'exec', 'nohup', 'time', 'busybox', 'nice', 'ionice', 'timeout', 'stdbuf'])
// Only flags that take a value in every wrapper: a guess here could skip the real command.
const WRAPPER_VALUE_FLAGS = new Set(['-u', '-g', '-n', '-C'])
const XARGS_VALUE_FLAGS = /^-[IdnLPsE]$/

/** The words of one simple command, its wrappers removed and its command name canonical. */
function words(segment: string): string[] {
  const list = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  for (;;) {
    const first = list[0] ?? ''
    const name = commandName(first)
    if (/^\w+=/.test(first)) {
      list.shift()
    } else if (WRAPPERS.has(name)) {
      list.shift()
      while (list[0]?.startsWith('-')) {
        const flag = list.shift() ?? ''
        if (WRAPPER_VALUE_FLAGS.has(flag)) list.shift()
      }
      if (name === 'timeout' && /^\d/.test(list[0] ?? '')) list.shift()
    } else if (name === 'xargs') {
      list.shift()
      while (list[0]?.startsWith('-')) {
        const flag = list.shift() ?? ''
        if (XARGS_VALUE_FLAGS.test(flag)) list.shift()
      }
    } else {
      break
    }
  }
  if (list.length > 0) list[0] = commandName(list[0] ?? '')

  return list
}

const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])

/** git's own words after its global options: `git -C dir push x` → `['push', 'x']`. */
function gitArgs(list: readonly string[]): string[] {
  let at = 1
  while (at < list.length && (list[at] ?? '').startsWith('-')) {
    at += GIT_VALUE_OPTIONS.has(list[at] ?? '') ? 2 : 1
  }

  return list.slice(at)
}

function canonical(segment: string): string {
  const list = words(segment)

  return (list[0] === 'git' ? ['git', ...gitArgs(list)] : list).join(' ')
}

// Commands with an `rm` subcommand of their own (`git rm -r`, `docker rm -f`).
const RM_HOSTS = new Set(['git', 'docker', 'podman', 'npm', 'pnpm', 'yarn', 'bun', 'kubectl', 'cargo', 'gh', 'helm', 'conda', 'pip', 'uv', 'poetry', 'dotnet', 'brew'])

/** The `rm` of a segment and what follows it: first, or after a wrapper the canonical form missed (`timeout -s KILL 5 rm -rf x`). */
function rmWords(segment: string, list: readonly string[]): readonly string[] | undefined {
  if (list[0] === 'rm') return list
  const raw = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  if (RM_HOSTS.has(list[0] ?? '')) return undefined
  const at = raw.findIndex((word, index) => index > 0 && commandName(word) === 'rm')

  return at > 0 ? ['rm', ...raw.slice(at + 1)] : undefined
}

function recursiveRm(list: readonly string[] | undefined): ShieldHit | undefined {
  if (list === undefined) return undefined
  const flags = list.filter(word => word.startsWith('-'))
  const isRecursive = flags.some(
    word => word === '--recursive' || (!word.startsWith('--') && /[rR]/.test(word)),
  )
  if (!isRecursive) return undefined
  const isForce = flags.some(word => word === '--force' || (!word.startsWith('--') && word.includes('f')))

  return {
    id: 'rm-recursive',
    why: isForce ? 'recursively force-deletes files (rm -rf)' : 'recursively deletes files (rm -r)',
  }
}

const POWER_COMMANDS = new Set(['shutdown', 'reboot', 'halt', 'poweroff', 'stop-computer', 'restart-computer'])

/** Only the command itself: `cat src/shutdown.ts` and `npm run reboot-api` are not a shutdown. */
function power(list: readonly string[]): ShieldHit | undefined {
  const name = list[0] ?? ''
  const isPower =
    POWER_COMMANDS.has(name) ||
    (name === 'systemctl' && list.slice(1).some(word => /^(reboot|poweroff|halt|kexec)$/.test(word)))

  return isPower ? { id: 'power', why: 'shuts down or restarts the machine' } : undefined
}

/** `release/*` matches `release/1.2`; a name without `*` matches only itself. */
export function branchMatches(branch: string, pattern: string): boolean {
  if (!pattern.includes('*')) return branch === pattern
  const source = pattern
    .split('*')
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')

  return new RegExp(`^${source}$`).test(branch)
}

function protectedPush(
  list: readonly string[],
  branch: string | null,
  protectedBranches: readonly string[],
): ShieldHit | undefined {
  if (list[0] !== 'git') return undefined
  const [sub, ...rest] = gitArgs(list)
  if (sub !== 'push') return undefined
  const args = rest.filter(word => !word.startsWith('-'))
  const refspecs = args.slice(1)
  const targets =
    refspecs.length > 0
      ? refspecs.map(spec => spec.replace(/^\+/, '').split(':').at(-1)?.replace(/^refs\/heads\//, '') ?? '')
      : branch === null
        ? []
        : [branch]
  const hit = targets
    .map(target => (target === 'HEAD' && branch !== null ? branch : target))
    .find(target => protectedBranches.some(pattern => branchMatches(target, pattern)))

  return hit === undefined
    ? undefined
    : { id: 'protected-push', why: `pushes straight to the protected branch "${hit}"` }
}

/** True when the command may push, so the current branch is worth reading. */
export function mayPush(command: string): boolean {
  return /\bgit\b[^;|&\n]*\bpush\b/.test(command)
}

export function scanCommand(
  command: string,
  context: { branch: string | null; protectedBranches: readonly string[] },
): ShieldHit[] {
  const hits: ShieldHit[] = []
  const add = (hit: ShieldHit | undefined) => {
    if (hit !== undefined && !hits.some(one => one.id === hit.id)) hits.push(hit)
  }
  const clean = neutralize(command)
  const parts = segments(clean)
  for (const segment of parts) {
    const list = words(segment)
    add(recursiveRm(rmWords(segment, list)))
    add(protectedPush(list, context.branch, context.protectedBranches))
    add(power(list))
  }
  const text = [clean, ...parts.map(canonical)].join('\n')
  for (const rule of RULES) {
    if (rule.re.test(text)) add({ id: rule.id, why: rule.why })
  }

  return hits
}

// ── Does a command change files? (worth a checkpoint and a check run) ────

const WRITING_COMMANDS = new Set([
  'rm', 'mv', 'cp', 'mkdir', 'rmdir', 'touch', 'ln', 'chmod', 'chown', 'tee', 'truncate', 'patch', 'unzip', 'rsync', 'dd',
  'black', 'isort',
  // PowerShell
  'new-item', 'ni', 'remove-item', 'ri', 'move-item', 'mi', 'copy-item', 'cpi', 'rename-item', 'rni',
  'set-content', 'add-content', 'out-file', 'clear-content', 'expand-archive', 'compress-archive',
  // cmd
  'del', 'erase', 'ren', 'rename', 'move', 'copy', 'xcopy', 'robocopy', 'md', 'rd', 'mklink',
])
const GIT_WRITERS = new Set([
  'checkout', 'switch', 'reset', 'restore', 'merge', 'rebase', 'pull', 'stash', 'apply', 'am', 'cherry-pick', 'revert', 'rm', 'mv', 'clean',
])
const PACKAGE_WRITERS: Record<string, Set<string>> = {
  npm: new Set(['i', 'install', 'ci', 'uninstall', 'un', 'rm', 'remove', 'update', 'up', 'link', 'add']),
  pnpm: new Set(['i', 'install', 'add', 'remove', 'rm', 'un', 'uninstall', 'update', 'up', 'link']),
  yarn: new Set(['install', 'add', 'remove', 'upgrade', 'up', 'link']),
  bun: new Set(['i', 'install', 'add', 'remove', 'rm', 'update', 'link']),
  pip: new Set(['install', 'uninstall']),
  pip3: new Set(['install', 'uninstall']),
  uv: new Set(['add', 'remove', 'sync', 'lock', 'init']),
  poetry: new Set(['add', 'remove', 'install', 'update', 'lock', 'init']),
  cargo: new Set(['add', 'remove', 'fix', 'fmt', 'update', 'new', 'init']),
  go: new Set(['get', 'mod', 'generate', 'fmt', 'work']),
  dotnet: new Set(['add', 'remove', 'new', 'format']),
  composer: new Set(['install', 'require', 'remove', 'update']),
  bundle: new Set(['install', 'add', 'update', 'remove']),
}
// `npm run <script>`: scripts that by their name write files.
const WRITING_SCRIPT = /(^|[:_-])(format|fmt|fix|build|gen|generate|codegen|migrate|clean|prepare|install)([:_-]|$)/i
const RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'uvx'])
const NULL_TARGET = /^(\/dev\/null|nul|\$null|\/dev\/std(out|err))$/i

/** A redirect into a real file: `> out.txt`, `>> log`; not `2>&1` or `> /dev/null`. */
function redirectsToFile(segment: string): boolean {
  const bare = segment.replace(/"[^"]*"|'[^']*'/g, '""')
  for (const match of bare.matchAll(/(?<![=\-<>])\d*>>?\|?\s*([^\s;&|<>]*)/g)) {
    const target = match[1] ?? ''
    if (target !== '' && !NULL_TARGET.test(target)) return true
  }

  return false
}

function writesFiles(list: readonly string[]): boolean {
  const name = list[0] ?? ''
  const args = list.slice(1)
  const sub = args.find(word => !word.startsWith('-')) ?? ''
  if (WRITING_COMMANDS.has(name)) return !(name === 'black' && args.some(word => word === '--check' || word === '--diff'))
  if (RUNNERS.has(name)) {
    const rest = [...args]
    while (rest[0]?.startsWith('-')) rest.shift()
    return writesFiles(words(rest.join(' ')))
  }
  if (name === 'python' || name === 'python3' || name === 'py') {
    const at = args.indexOf('-m')
    return at >= 0 && writesFiles(args.slice(at + 1))
  }
  if (name === 'git') return GIT_WRITERS.has(gitArgs(list)[0] ?? '')
  if (name === 'sed') return args.some(word => /^(-[a-zA-Z]*i|--in-place)/.test(word))
  if (name === 'perl') return args.some(word => /^-[a-zA-Z]*i/.test(word))
  if (name === 'tar') {
    return args.some(word => word === '--extract' || word === '--create') || /^-?[a-zA-Z]*[xc][a-zA-Z]*$/.test(args[0] ?? '')
  }
  if (name === 'gofmt') return args.includes('-w')
  if (name === 'prettier' || name === 'biome' || name === 'stylelint' || name === 'eslint' || name === 'ruff') {
    return args.some(word => word === '--write' || word === '-w' || word === '--fix') || (name === 'ruff' && sub === 'format')
  }
  if (name === 'uv' && sub === 'pip') return /^(install|uninstall|sync)$/.test(args[args.indexOf('pip') + 1] ?? '')
  const writers = PACKAGE_WRITERS[name]
  if (writers === undefined) return false
  if (name === 'yarn' && sub === '') return true
  if (writers.has(sub)) return true
  if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') {
    const script = sub === 'run' || sub === 'run-script' ? (args[args.indexOf(sub) + 1] ?? '') : name === 'yarn' || name === 'pnpm' ? sub : ''
    return WRITING_SCRIPT.test(script)
  }

  return false
}

/** True when the command is likely to change files, so a checkpoint is worth taking. */
export function isMutatingCommand(command: string): boolean {
  return segments(neutralize(command)).some(segment => redirectsToFile(segment) || writesFiles(words(segment)))
}
