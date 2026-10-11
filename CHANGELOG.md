# Changelog

## 0.6.0 (2026-10-11)

- **Lean mode:** terse replies and minimal code as rules in the system prompt, on by default (`lite` talk, minimal code on). `/lean-nexus` switches a level or turns them off mid-session (from the next turn; the prompt cache resets once); the pick is remembered across sessions.
- The Executive Summary keeps its three headings but goes terse while lean talk is on.
- `/lean-review-nexus [base]`: Claude reviews the changes for over-engineering against the same ladder; edits nothing.
- `/compress-nexus [file]`: shortens CLAUDE.md with the helper model; refuses a result that loses a code block, path, URL or number; asks first and keeps a backup.
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
