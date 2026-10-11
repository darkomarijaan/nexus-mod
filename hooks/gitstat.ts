/**
 * The work tree beside the HUD's branch, from one `git status --porcelain=v2
 * --branch`: commits to push and pull, and how many files are staged,
 * changed, untracked or in conflict.
 */

import type { NexusGit } from '../types'
import type { ThemeIcons } from './theme'

export type GitState = NexusGit

/** The arguments the HUD reads the work tree with; no optional locks, so Claude's own git calls never wait on it. */
export const GIT_STATUS_ARGS = ['--no-optional-locks', 'status', '--porcelain=v2', '--branch'] as const

/** The branch (a detached HEAD as its short commit) and the work tree. */
export function parseGitStatus(stdout: string): { branch: string | null; git: GitState } {
  const git: GitState = { upstream: null, ahead: 0, behind: 0, staged: 0, changed: 0, untracked: 0, conflicts: 0 }
  let head: string | null = null
  let oid: string | null = null
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('# branch.oid ')) oid = line.slice(13).trim()
    else if (line.startsWith('# branch.head ')) head = line.slice(14).trim()
    else if (line.startsWith('# branch.upstream ')) git.upstream = line.slice(18).trim()
    else if (line.startsWith('# branch.ab ')) {
      const match = /\+(\d+) -(\d+)/.exec(line)
      git.ahead = Number(match?.[1] ?? 0)
      git.behind = Number(match?.[2] ?? 0)
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      // XY: the index (staged) side, then the work tree side; '.' is unchanged.
      if (line[2] !== '.') git.staged += 1
      if (line[3] !== '.') git.changed += 1
    } else if (line.startsWith('u ')) git.conflicts += 1
    else if (line.startsWith('? ')) git.untracked += 1
  }
  const branch = head === '(detached)' ? (oid !== null && oid !== '(initial)' ? `(${oid.slice(0, 7)})` : null) : head

  return { branch, git }
}

export type GitMark = { text: string; role: 'accent' | 'ok' | 'warn' | 'bad' | 'idle' }

/** What the header draws after the branch: only the counts that are not zero. */
export function gitMarks(git: GitState | null, icons: Pick<ThemeIcons, 'ahead' | 'behind'>): GitMark[] {
  if (git === null) return []
  const marks: [number, string, GitMark['role']][] = [
    [git.ahead, icons.ahead, 'accent'],
    [git.behind, icons.behind, 'warn'],
    [git.staged, '+', 'ok'],
    [git.changed, '~', 'warn'],
    [git.untracked, '?', 'idle'],
    [git.conflicts, '!', 'bad'],
  ]

  return marks.filter(([count]) => count > 0).map(([count, sign, role]) => ({ text: `${sign}${count}`, role }))
}
