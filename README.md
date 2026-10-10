# Nexus: a Claude Code mod

An all-in-one workspace suite for Claude Code:

- **HUD bar** above the prompt: git branch, model, the 5-hour limit used with its countdown (`5h: 26% [reset 1h 42m]`), the weekly limit used with its reset day (`Wk: 38% [Mon]`), context tokens, output speed (`⚡ 58 tok/s`), prompt-cache hits (`◎ cache 92%`), a red warning when a reply was cut off (`⚠ reply cut off: hit max tokens`), and a status light for every Claude Code session on the machine (green working, yellow waiting, gray idle).
- **Task meter**: the task Claude is on and how much of its todo list is done (`[Task: Running unit tests (68%)]`).
- **Prompt enhancer**: turns a rough prompt into Goal / Context / Acceptance criteria.
- **Assumption review**: before a plan is shown, you confirm or correct the assumptions Claude made.
- **Command Shield**: asks before dangerous shell commands run.
- **Secret masking**: hides API keys, tokens and passwords before they are stored or sent, and stops Claude from writing a mask back over the real secret.
- **Turn checkpoints** with `/rollback-nexus`.
- **Design Lens**: UI options shown as live visual cards in your browser.
- **Auto lint/test** with self-healing.
- **Clean delivery**: a quiet transcript and a plain-English final summary.
- **Limit forecast**: from how fast 5h and weekly usage climb, a red `⚠ out ~1h 10m` when the pace runs the window out before it resets.
- **Done / approval alerts**: a desktop notification and a sound when a long turn finishes, a different sound when Claude needs your approval.
- **Compaction guard**: a warning at 80% context, and compaction told to keep file paths, open tasks, check results and decisions.
- **Session handoff**: what each session did is saved; the next session in the project shows it, and `/handoff-nexus` hands it to Claude.
- **Loop detector**: when the same call fails 3 times (or repeats 6 times) Claude is told to change approach; a turn past 20 minutes is flagged.
- **Cache freshness**: `warm 2m`, `idle 12m` or `cold` beside the cache hits, so you know whether the next reply starts cold.
- **Subagent monitor**: running subagents in the HUD and in `/sessions-nexus` with how long each has run, and an optional cap.
- **Next-step suggestion**: the reply's first Next Step offered as the prompt's dim suggestion; Tab takes it.
- **Commit helper**: after changes, a `Commit` button and `/commit-nexus` draft a message from the diff and commit once you confirm.
- **Themes (skins)**: nine looks for the HUD and drawers (colors, bar glyphs, icons, borders): `default`, `claude` (follows Claude Code's own `/theme`), `dracula`, `nord`, `ocean`, `sunset`, `forest`, `mono` and `ascii` (for fonts without Unicode). Switch with `/skin-nexus`; the pick is remembered across sessions, and Claude Code's own theme follows it (a dark skin moves it to dark, `default` puts yours back).

## Requirements

- Claude Code 2.1.296 or newer
- `git` on PATH (for checkpoints and rollback)
- `node` on PATH (optional: lets a click in the browser preview reach Claude)
- Microsoft Edge or Google Chrome (optional: for `/preview-nexus` screenshots)

## Install

**From GitHub** (you need access to the repository):

```
claude plugin marketplace add darkomarijaan/nexus-mod
claude plugin install nexus@nexus-mod
```

**From a local folder** (a clone or the unzipped `nexus-mod.zip`), kept on an NTFS drive:

```
claude plugin marketplace add C:\path\to\nexus-mod
claude plugin install nexus@nexus-mod
```

Then run `/reload-plugins` in any open session, or start a new one.

**Try it for one session only**

```
claude --plugin-dir C:\path\to\nexus-mod
```

> Keep the folder on an NTFS drive. Claude Code cannot read a plugin folder on an exFAT or FAT32 drive (the install fails with `EISDIR ... readlink`).

## Use

| Command | What it does |
|---|---|
| `/nexus` | Status of every module, and the keys |
| `/sessions-nexus` | Every Claude Code session on this machine: inspect, ask one to pause, message it, copy its resume command |
| `/idea-nexus <text>` | Save an idea to `.claude/ideas.md` without interrupting Claude (no text opens the scratchpad) |
| `/rollback-nexus` | Put the project back as it was before the latest turn (edits you made since are undone too). Also `/rollback-nexus list`, `/rollback-nexus 3`, `/rollback-nexus undo` |
| `/preview-nexus [url]` | Screenshot the dev server; run it again after changes for a before/after comparison |
| `/handoff-nexus` | What the last session in this project did; Claude reads it too, so it can pick the work up |
| `/commit-nexus` | Commit every change in the work tree with a drafted message, after you confirm it |
| `/skin-nexus` | Open the skin picker. Also `/skin-nexus <name>`, `/skin-nexus list`, `/skin-nexus reset` (back to the configured one) |

**Keys:** press `ctrl+x tab` to focus the bar above the prompt, then one letter:

| Key | Action |
|---|---|
| `e` | Enhance |
| `g` | Send |
| `s` | Sessions |
| `i` | Idea |
| `z` | Rollback |
| `p` | Preview |
| `t` | Skin (on a wide terminal) |
| `c` | Commit (shown after a turn that changed files, in a git repo) |

So `ctrl+x tab s` opens Sessions, `ctrl+x tab i` the idea pad, `ctrl+x tab z` rolls back. A mod cannot take a bare `ctrl+z` or a `ctrl+x s` chord in this Claude Code build, so the keys go through the bar.

The quotas show on a Claude subscription once the first reply of the session arrives; on an API key there are none to show.

## Settings

Change these with `/plugin configure nexus@nexus-mod` in Claude Code (or `/plugin`, pick nexus, then Configure).

| Setting | Default | What it controls |
|---|---|---|
| Command Shield | on | Ask before dangerous commands |
| Protected branches | `main,master,production,release` | Branches guarded against pushes; `*` matches any part (`release/*`) |
| Secret Leak Sanitizer | on | Mask credentials |
| Turn checkpoints | on | Snapshot before each turn's first change |
| Assumption review | `plan` | `plan`, `first-edit` or `off` |
| Auto lint/test | on | Run project checks after changes |
| Self-heal attempts | `2` | Times a failure is sent back to Claude |
| Check timeout | `180` s | Longest one check may run |
| Quiet transcript | on | Routine tool calls drawn as one line |
| Executive summary | on | What Changed / Verification Status / Next Steps |
| Design Lens | on | Visual design cards |
| Dev server URL | empty | `/preview-nexus` target (empty: probe localhost) |
| Helper model | `haiku` | Model for Enhance, assumption review and commit messages |
| Done / approval alerts | on | Notification and sound when a long turn ends or Claude needs you |
| Alert after | `30` s | Only turns at least this long raise the done alert |
| Compaction guard | on | 80% warning and what compaction must keep |
| Session handoff | on | Save each session's summary for the next |
| Loop detector | on | Break repeated failing calls; flag 20-minute turns |
| Max subagents at once | `0` | Refuse new subagents past this many (0: no limit) |
| Next-step suggestion | on | Offer the reply's first Next Step as the prompt suggestion |
| Commit helper | on | Commit button and `/commit-nexus` |
| Theme | `default` | Starting theme; a `/skin-nexus` pick overrides it until `/skin-nexus reset` |
| Claude Code theme follows the skin | on | A dark skin moves Claude Code's own theme to dark (daltonized kept), `ascii` to ANSI; `default` and `claude` put your own theme back |

## Where it keeps things

- Checkpoints live in a private shadow git repo under `~/.claude/nexus/shadow/`. Your project's own `.git` is never touched. The last 40 are kept; older ones are freed at most once a week.
- Rollback does not cover `node_modules`, `dist`, `build`, `.venv` or other build folders.
- Previews and screenshots are written to `~/.claude/nexus/previews/`.
- Session handoffs are kept in the plugin's own store, one per project; nothing is written into your project.
- Sounds use the system's own (`Windows Notify System Generic` and `Windows Exclamation` on Windows). Whether the notification shows as a desktop toast depends on Claude Code's notification channel (`/config`, Notifications).
