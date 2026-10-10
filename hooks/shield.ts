export type ShieldHit = { id: string; why: string }

type Rule = { id: string; why: string; re: RegExp }

const RULES: Rule[] = [
  {
    id: 'win-recursive-delete',
    why: 'recursively deletes files',
    re: /\b(remove-item|ri|rmdir|rd|del|erase)\b[^;|&\n]*\s(-recurse\b|-r\b|\/s\b)/i,
  },
  { id: 'find-delete', why: 'deletes every file a search matches', re: /\bfind\b[^;|&\n]*\s-delete\b/ },
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
    id: 'sql-delete-all',
    why: 'deletes every row of a table (DELETE with no WHERE)',
    re: /\bdelete\s+from\s+[\w."`[\]]+\s*(;|"|'|$)/im,
  },
  {
    id: 'db-reset',
    why: 'drops or resets a database',
    re: /\b(dropdb|prisma\s+migrate\s+reset|db:drop|db:reset|flushall|flushdb)\b/i,
  },
  { id: 'disk-format', why: 'formats or overwrites a disk', re: /\b(mkfs(\.\w+)?|diskpart|format-volume)\b|\bdd\b[^;|&\n]*\bof=\/dev\/|\bformat\s+[a-z]:/i },
  { id: 'fork-bomb', why: 'is a fork bomb', re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/ },
  {
    id: 'power',
    why: 'shuts down or restarts the machine',
    re: /\b(shutdown|reboot|halt|poweroff|stop-computer|restart-computer)\b/i,
  },
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

/** Splits a shell line into simple commands at ; && || | and newlines. */
function segments(command: string): string[] {
  return command
    .split(/\n|;|&&|\|\||\|/)
    .map(part => part.trim())
    .filter(Boolean)
}

function words(segment: string): string[] {
  const list = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  const skip = new Set(['sudo', 'doas', 'env', 'command', 'exec', 'nohup', 'time'])
  while (list.length > 0 && (skip.has(list[0] ?? '') || /^\w+=/.test(list[0] ?? ''))) {
    list.shift()
  }

  return list
}

function recursiveRm(segment: string): ShieldHit | undefined {
  const list = words(segment)
  if (list[0] !== 'rm') return undefined
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

function protectedPush(
  segment: string,
  branch: string | null,
  protectedBranches: readonly string[],
): ShieldHit | undefined {
  const list = words(segment)
  if (list[0] !== 'git' || list[1] !== 'push') return undefined
  const args = list.slice(2).filter(word => !word.startsWith('-'))
  const refspecs = args.slice(1)
  const targets =
    refspecs.length > 0
      ? refspecs.map(spec => spec.replace(/^\+/, '').split(':').at(-1)?.replace(/^refs\/heads\//, '') ?? '')
      : branch === null
        ? []
        : [branch]
  const hit = targets.find(target =>
    protectedBranches.includes(target === 'HEAD' && branch !== null ? branch : target),
  )

  return hit === undefined
    ? undefined
    : { id: 'protected-push', why: `pushes straight to the protected branch "${hit}"` }
}

export function scanCommand(
  command: string,
  context: { branch: string | null; protectedBranches: readonly string[] },
): ShieldHit[] {
  const hits: ShieldHit[] = []
  const add = (hit: ShieldHit | undefined) => {
    if (hit !== undefined && !hits.some(one => one.id === hit.id)) hits.push(hit)
  }
  for (const segment of segments(command)) {
    add(recursiveRm(segment))
    add(protectedPush(segment, context.branch, context.protectedBranches))
  }
  for (const rule of RULES) {
    if (rule.re.test(command)) add({ id: rule.id, why: rule.why })
  }

  return hits
}

/** True when the command is likely to change files, so a checkpoint is worth taking. */
export function isMutatingCommand(command: string): boolean {
  return /(^|[\s;&|])(>|>>)\s*\S|\b(rm|mv|cp|mkdir|rmdir|touch|ln|chmod|sed\s+-i|perl\s+-pi|tee|truncate|patch|unzip|tar\s+-?x|npm\s+(i|install|uninstall|update|run\s+(format|fix|build))|pnpm\s+(i|add|install|remove)|yarn\s+(add|remove|install)?|pip\s+install|cargo\s+(add|fix|fmt)|go\s+(get|mod)|prettier\s+--write|eslint\s+[^;|&\n]*--fix|ruff\s+[^;|&\n]*--fix|black|gofmt\s+-w|git\s+(checkout|switch|reset|restore|merge|rebase|pull|stash|apply|am|cherry-pick|revert|rm|mv|clean)|new-item|remove-item|move-item|copy-item|rename-item|set-content|add-content|out-file|del|erase|ren|move|copy|xcopy|robocopy)\b/i.test(
    command,
  )
}
