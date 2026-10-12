// Claude Code ends a session with "Resume this session with: claude --resume <id>",
// the command name hardcoded. Behind the router that command is wrong (plain
// `claude` bypasses it), so the launcher names the right one after claude exits.
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Claude Code keeps a project's transcripts in a folder named after its path.
export const projectSlug = cwd => cwd.replace(/[^a-zA-Z0-9]/g, '-')

// The session in `cwd` whose transcript was written since `since` (ms), newest first.
export const latestSession = (configDir, cwd, since) => {
  const dir = join(configDir, 'projects', projectSlug(cwd))
  let newest
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue
      const written = statSync(join(dir, name)).mtimeMs
      if (written >= since && (newest === undefined || written > newest.written)) newest = { id: name.slice(0, -'.jsonl'.length), written }
    }
  } catch {
    return undefined
  }
  return newest?.id
}

export const resumeHint = (command, id) => `Behind the router, resume with:\n${command} --resume ${id}`
