# Nexus: a Claude Code mod

Version 0.6.0 ([changelog](CHANGELOG.md)).

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
- **Compaction guard**: a warning at 80% context, compaction told to keep file paths, open tasks, check results and decisions, and right after it a note to Claude with your last request word for word, the open tasks, the files touched and the opening of CLAUDE.md.
- **Context audit**: `/context-nexus` shows where the context goes before you type (MCP servers, CLAUDE.md and other memory files, skills by plugin, agent types) and what could go.
- **MCP servers per project**: `/mcp-nexus off <server>` keeps a server's tools out of Claude's way in this project (a one-line note behind ToolSearch, calls refused); `/mcp-nexus on <server>` brings it back.
- **Trimmed noisy output**: long install, build, test and log output reaches Claude with its routine lines folded (problems, head and tail kept); the whole output is saved to a file Claude can read.
- **Lean mode**: terse replies (`lite` by default, `ultra` for telegraphic) and minimal code (Claude checks whether the code is needed, already in the codebase, in the standard library or a native feature before writing new code). Switch it with `/lean-nexus`; the HUD shows `✂ lite · min` while it is on.
- **Quota guard**: when the 5-hour or weekly limit passes 90% (configurable), Nexus asks whether the running turn goes on, or, between turns, whether your next prompt goes; once per window.
- **Turn footer**: a dim line under each answer, `⏱ 3m 12s · 14 tools · 4 files · ctx 42% · checks ✓`.
- **Provider router**: start Claude Code with `claude-nexus` and switch the session between your Claude subscription and your own hub (URL, API key, models for opus/sonnet/haiku) without a restart. When Claude's plan limit is hit, Nexus offers to continue the same turn on a hub, and offers Claude again once the quota resets. Plain `claude` is untouched and keeps Remote Control; a `claude-nexus` session has no Remote Control (Claude Code turns it off whenever `ANTHROPIC_BASE_URL` is set).
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

**Update** to a newer version:

```
claude plugin marketplace update nexus-mod
claude plugin update nexus@nexus-mod
```

From a local folder, first replace its contents with the new release (`git pull` in a clone, or unzip the new `nexus-mod.zip` over it). Then `/reload-plugins` or start a new session. `claude plugin list` shows the installed version.

**Where the `bin` folder is** (needed once, for the [provider router](#provider-router)):

| Installed from | Nexus's `bin` folder |
|---|---|
| GitHub | `%USERPROFILE%\.claude\plugins\marketplaces\nexus-mod\bin` (Windows), `~/.claude/plugins/marketplaces/nexus-mod/bin` (macOS, Linux) |
| A local folder | `<that folder>\bin`, e.g. `C:\path\to\nexus-mod\bin` |

Use these paths, not the copy under `.claude\plugins\cache\...`: that folder's name carries the version, so it changes with every update.

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
| `/enhance-nexus <rough prompt>` | Rewrite a rough prompt as Goal / Context / Acceptance criteria into the prompt box, to read before sending |
| `/context-nexus` | Where the context goes before you type, and what could go |
| `/mcp-nexus` | MCP servers in this project; `/mcp-nexus off <server>`, `/mcp-nexus on <server>` |
| `/lean-nexus` | Terse replies and minimal code: `/lean-nexus talk off\|lite\|ultra`, `/lean-nexus code on\|off`, `/lean-nexus off`, `/lean-nexus reset` (back to Settings) |
| `/lean-review-nexus` | Claude reviews the uncommitted changes (or `/lean-review-nexus main`) for over-engineering and reports `file:line` findings; edits nothing |
| `/compress-nexus` | Shortens `CLAUDE.md` (or `/compress-nexus <file>`) with the helper model, shows the saving, asks, and keeps a backup of the original (refuses a result that changes a code block, inline code, path, URL or number, or saves under 5%) |
| `/skin-nexus` | Open the skin picker. Also `/skin-nexus <name>`, `/skin-nexus list`, `/skin-nexus reset` (back to the configured one) |
| `/provider-nexus` | Provider profiles: add, edit, test, use. Also `/provider-nexus <name\|claude>` (switch), `/provider-nexus status`, `/provider-nexus test <name>` |

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
| `r` | Claude ⇄ hub: to the hub used last (else the default fallback) and back; in a plain `claude` session it copies the restart command (shown once a provider profile exists) |

So `ctrl+x tab s` opens Sessions, `ctrl+x tab i` the idea pad, `ctrl+x tab z` rolls back. Press `ctrl+x`, let go, then `tab`: `ctrl+x` alone shows nothing. In VS Code's terminal, turn on `terminal.integrated.sendKeybindingsToShell` if `ctrl+x tab` does not reach Claude Code. Every key also has a command (`/enhance-nexus`, `/sessions-nexus`, `/idea-nexus`, `/rollback-nexus`, `/preview-nexus`, `/skin-nexus`, `/commit-nexus`). A mod cannot take a bare `ctrl+z` or a `ctrl+x s` chord in this Claude Code build, so the keys go through the bar.

The quotas show on a Claude subscription once the first reply of the session arrives; on an API key there are none to show.

## Provider router

Switching providers needs Claude Code started through the launcher, `claude-nexus`, which puts a small router in front of it. On the Claude route it behaves like plain `claude`, so you can use it as your everyday command; the one thing it gives up is Remote Control, which refuses any custom API address. Stay on plain `claude` when you want Remote Control.

1. Once: put Nexus's `bin` folder ([where it is](#install)) on your PATH, then open a new terminal. Windows (PowerShell), for a GitHub install:
   ```
   [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ";$env:USERPROFILE\.claude\plugins\marketplaces\nexus-mod\bin", 'User')
   ```
   macOS, Linux: add `export PATH="$HOME/.claude/plugins/marketplaces/nexus-mod/bin:$PATH"` to `~/.zshrc` or `~/.bashrc`. Check with `claude-nexus --version`. `claude-nexus` takes every `claude` argument (`claude-nexus --resume <id>`, `claude-nexus -c`).
2. Once: `/provider-nexus` → **Add profile**: name, hub URL (the base that ends in `/v1`, e.g. `https://hub.example.com/v1`), API key, then pick the models from the hub's list, the context window and whether to offer it when Claude's quota runs out. **Test** sends one short request per model. Profiles are kept for every session.
3. Switch: `ctrl+x tab r`, **Use** in the pane, or `/provider-nexus myhub`. In a `claude-nexus` session it takes effect at the next request, and `r` again (or `/provider-nexus claude`) goes back. The HUD shows `⇄ <profile> · <model>` while a hub is in use.
4. From a plain `claude` session the same switch copies `cd "<project>"; claude-nexus --resume <this session>`: type `/exit`, paste, Enter. The conversation goes on under `claude-nexus`, already on that profile (the switch waits up to 15 minutes). When Claude's quota runs out mid-turn, the quota question offers the same.

The hub must speak the Anthropic Messages API (`POST <hub URL>/messages`), as OmniRoute, LiteLLM and claude-code-router do. Your claude.ai login stays the credential on the Claude route; the hub key is added by the router only on hub requests, and the login never reaches the hub. Profiles, keys included, live in Nexus's local store. Set `NEXUS_ROUTER_DEBUG=1` before `claude-nexus` to log each request's route and status to `~/.claude/nexus/router-<pid>.log`.

Things to know inside a `claude-nexus` session:

- Scripts and tools you run there that call Anthropic themselves (the SDK, a nested `claude`) inherit `ANTHROPIC_BASE_URL` and reach the router without its token, so they get a 401 (a nested `claude` would ride the outer router instead). Unset `ANTHROPIC_BASE_URL` for them.
- `env` in `~/.claude/settings.json`, `.claude/settings.json` or `.claude/settings.local.json` overrides what the launcher sets. If any of them sets `ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS` or `ANTHROPIC_AUTH_TOKEN`, `claude-nexus` warns at start (naming the file and the variable) and the router refuses a request that lacks its token with an error that says so.

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
| Compaction guard | on | 80% warning, what compaction must keep, and the note to Claude after it |
| Session handoff | on | Save each session's summary for the next |
| Loop detector | on | Break repeated failing calls; flag 20-minute turns |
| Max subagents at once | `0` | Refuse new subagents past this many (0: no limit) |
| Next-step suggestion | on | Offer the reply's first Next Step as the prompt suggestion |
| Commit helper | on | Commit button and `/commit-nexus` |
| Theme | `default` | Starting theme; a `/skin-nexus` pick overrides it until `/skin-nexus reset` |
| Claude Code theme follows the skin | on | A dark skin moves Claude Code's own theme to dark (daltonized kept), `ascii` to ANSI; `default` and `claude` put your own theme back |
| Trim noisy output | on | Fold routine lines of long install, build, test and log output |
| Lean talk | lite | Terse replies: off, lite or ultra |
| Minimal code | on | Climb the minimal-code ladder before writing code |
| Quota guard | `90` % | Ask before going on past this share of the 5-hour or weekly limit (0: off) |
| Turn footer | on | Time, tools, files, context and checks under each answer |
| Provider fallback | `ask` | In a `claude-nexus` session, when Claude's plan limit is hit: `ask`, `auto` (default fallback profile) or `off` |

## Where it keeps things

- Checkpoints live in a private shadow git repo under `~/.claude/nexus/shadow/`. Your project's own `.git` is never touched. The last 40 are kept; older ones are freed at most once a week.
- Rollback does not cover `node_modules`, `dist`, `build`, `.venv` or other build folders.
- Previews and screenshots are written to `~/.claude/nexus/previews/`.
- Whole outputs of trimmed commands go to `~/.claude/nexus/outputs/` (the last 30).
- `/compress-nexus` keeps each original in `~/.claude/nexus/backups/<project folder>-<file>.bak-<time>`, never in your project; a refused result is left in `~/.claude/nexus/outputs/compress-last.md` for comparison.
- Session handoffs are kept in the plugin's own store, one per project; nothing is written into your project.
- Sounds use the system's own (`Windows Notify System Generic` and `Windows Exclamation` on Windows). Whether the notification shows as a desktop toast depends on Claude Code's notification channel (`/config`, Notifications).

## Roadmap

- **v0.5**: provider router; v0.5.1: one-key switch, switching from a plain session by resuming it under claude-nexus.
- **v0.6** (this version): lean mode (terse replies, minimal code), `/lean-review-nexus`, `/compress-nexus`.
- **v0.7**: test-tamper guard, evidence check before "done", `/review-nexus`.
- **v0.8**: hunk-level diff review, plan annotation in the browser.
- Later: Telegram remote control, session search, worktree cockpit.

## License

MIT, see [LICENSE](LICENSE).
