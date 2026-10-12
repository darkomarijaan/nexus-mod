# Changelog

## 0.6.3 (2026-10-12)

- **Provider form:** editing a profile now picks its models from the hub's list, as adding one does. The model already set stays a choice even when the hub leaves it out of its list (or past the first 60).

## 0.6.2 (2026-10-11)

- **Git counts in the HUD:** beside the branch, `↑2` commits to push, `↓1` to pull, `+3` files staged, `~2` changed, `?1` untracked, `!1` in conflict, in the skin's colors (`^` and `v` in ASCII skins); a clean branch in step shows none. One `git --no-optional-locks status --porcelain=v2 --branch` reads it all; a turn that changed files reads it again at once, and a status too slow for its timeout still names the branch.
- **Agents panel:** `/agents-nexus`, or `a` in the HUD once a subagent has run, follows every subagent of the session live: model, a context bar, tools run and the one running now, how long it has run, a `⚠ quiet` mark after two minutes without a tool, and the steps it reports. Finished ones stay listed with time, tools and tokens; one that is resumed is running again. Pick a running one with `1`-`9` and type to send it a message. Inspired by savvy-progress (johnnyvizz/claude-kit).
- **Step reports:** subagents get a `step` tool to report `step 3/5 writing tests` to the panel; the Agent step reports setting (on by default) turns it off, and the panel then shows what it observes only.

## 0.6.1 (2026-10-11)

- **Eight more skins**, seventeen in all: `gruvbox`, `mocha` (Catppuccin Mocha), `tokyo` (Tokyo Night), `rosepine`, `monokai`, `latte` (Catppuccin Latte, for light terminals: Claude Code's own theme goes light, daltonized kept), `contrast` (high contrast, Okabe-Ito colorblind-safe hues) and `phosphor` (a green CRT in plain ASCII glyphs). The skin picker gives skins past the ninth the keys `a`-`h`.
- **`/mcp-nexus` switcher:** with no argument it opens a pane listing every MCP server with its tools, the tokens it keeps in front of Claude and whether it still needs sign-in. One key turns a server off or on in this project; `x` turns off every server not signed in, `o` turns them all back on.
- `/mcp-nexus off|on` take several names, and part of a name when only one server has it (`/mcp-nexus off gmail calendar`); a part several servers share changes nothing and names them. `off unused` and `on all` switch many at once; `list` prints the aligned list.
- README: the HUD's `[-]` is Claude Code's fold mark (clicks only reach it in the fullscreen layout; `ctrl+x ctrl+a` works everywhere), and the skins screenshot shows all seventeen.

## 0.6.0 (2026-10-11)

- **Lean mode:** terse replies and minimal code as rules in the system prompt, on by default (`lite` talk, minimal code on). `/lean-nexus` switches a level or turns them off mid-session (from the next turn; the prompt cache resets once); the pick is remembered across sessions.
- The Executive Summary keeps its three headings but goes terse while lean talk is on.
- `/lean-review-nexus [base]`: Claude reviews the changes for over-engineering against the same ladder; edits nothing.
- `/compress-nexus [file]`: shortens CLAUDE.md with the helper model; refuses a result that changes a code block (a fence's language tag aside), inline code, path, URL or number, that was cut off, or that saves under 5%; asks first and keeps the original in `~/.claude/nexus/backups/`. A refused result is left in `~/.claude/nexus/outputs/compress-last.md`.
- `CLAUDE.md` for working on Nexus itself: commands, architecture and mod API gotchas.
- HUD badge `✂ lite · min`; the turn footer shows the turn's output tokens (`out 1.2k`).

## 0.5.1 (2026-10-11)

- **One-key switch:** `ctrl+x tab r` flips between Claude and the hub used last (else the default fallback profile). The last hub is remembered across sessions.
- **Switching from a plain `claude` session:** `/provider-nexus <name>`, the `r` key and the quota question copy `cd "<project>"; claude-nexus --resume <this session>`. Type `/exit`, paste, Enter: the conversation goes on under `claude-nexus`, already on that profile (when it starts within 15 minutes in the same folder).
- `/provider-nexus <name|claude>` is short for `/provider-nexus use <name|claude>`.
- README: when to use `claude-nexus` and when to stay on plain `claude` (Remote Control only works on plain `claude`), how to update, and where the `bin` folder is for each install method.

## 0.5.0 (2026-10-11)

- **Provider router:** the `claude-nexus` launcher starts Claude Code behind a local router, so a session can switch between Claude and your own hub (any Anthropic Messages API: OmniRoute, LiteLLM, claude-code-router) without restarting.
- `/provider-nexus`: a pane for provider profiles (hub URL, API key, models picked from the hub's list, context window, fallback) with a connection test. Profiles live in Nexus's local store; keys are masked everywhere.
- **Fallback on plan limits:** when Claude's 5-hour or weekly limit is hit, the request is held and offered to a fallback hub, then Claude is offered back once the window resets.
- Your claude.ai login stays the credential on the Claude route and never reaches the hub; the hub key is added by the router only on hub requests.
- HUD badge `⇄ <profile> · <model>` while a hub is in use; compaction is offered before switching to a hub with a smaller window.
- `NEXUS_ROUTER_DEBUG=1` logs each request's route and status to `~/.claude/nexus/router-<pid>.log`.

## 0.4.2 (2026-10-11)

- The next-step suggestion recognises Indonesian headings ("Langkah berikutnya", "Langkah selanjutnya", "Selanjutnya", "Berikutnya") and "tidak ada" / "belum ada" as none.

## 0.4.1 (2026-10-10)

- `/enhance-nexus <rough prompt>`: the Enhance key as a command, for terminals where `ctrl+x tab` does not reach Claude Code (VS Code).
- The band's Send submits as the person, so the quota guard and compaction anchor see the prompt.
- `/nexus` and the README list the command for every key.

## 0.4.0 (2026-10-10)

- **Compaction anchor:** after a compaction Claude gets your last request word for word, open tasks, files touched, check results and the opening of CLAUDE.md.
- `/context-nexus`: where the context goes, with suggestions on what could go.
- `/mcp-nexus off|on <server>`: turn MCP servers off per project.
- Noisy shell output (installs, builds, tests, logs) is folded before Claude reads it; the whole output is saved to `~/.claude/nexus/outputs/`.
- **Quota guard:** past 90% (configurable) of the 5-hour or weekly limit, asks whether the turn or the next prompt goes on.
- Turn footer: time, tools, files, context and checks under each answer.

## 0.3.1 (2026-10-10)

- Secret masks: writing a mask back over a real secret is asked about first.
- Rollback: a typo or 0 is refused instead of restoring the latest checkpoint.
- Shield: sees through git global options, `/bin` paths, xargs, busybox, timeout and `find -exec rm`; protected branches take `*` patterns; fewer false alarms.
- Read-only commands no longer trigger checkpoints or checks; old checkpoints are freed by a weekly gc.
- Loop detector compares the whole call; dead sessions hidden from the HUD; Windows-safe resume command.

## 0.3.0 (2026-10-10)

- **Skins:** nine looks for the HUD and drawers, picked with `/skin-nexus` and remembered across sessions; dark skins move Claude Code to a dark theme.
- Every command ends in `-nexus` so none collides with a built-in.

## 0.2.0 (2026-10-10)

- First release: HUD dashboard (branch, model, sessions, usage with forecast, context, cache hits, tok/s, task meter), prompt enhancer, assumption review, command shield, secret masking, turn checkpoints with rollback, design lens, auto lint/test with self-heal, done/approval alerts, compaction guard, session handoff, loop detector, subagent monitor, next-step suggestion and commit helper.
