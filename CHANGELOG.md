# Changelog

## 0.7.4 (2026-11-18)

- **Jev key in one command:** `claude-nexus jev-key` asks for the key with nothing shown as you paste it, and saves it to `~/.claude/nexus/.env`, the file the router reads. It never goes through a chat, a command argument or a settings file, and the screen shows only its length. `claude-nexus jev-key --remove` forgets it. `/automodel-nexus` now names this command when no key is found.
- **Auto Model stays on one model in a long conversation:** a prompt cache belongs to one model, so each switch re-sent the whole conversation uncached. From 40 messages (or about 150 KB) on, a turn keeps the tier of the one before, except that it still moves up at once or drops two tiers at once; dropping one tier waits for three such turns in a row (reason code `sticky`). A short "ok" no longer flips the model.

## 0.7.3 (2026-11-18)

- **`/automodel-nexus jev gray|always|off|reset`:** turn the optional Jev classifier on or off from inside the session, without editing a settings file. The pick is remembered across sessions and beats the plugin setting until `jev reset`. It only decides whether Jev is used: the key and the hosts it may go to are still never set from here.
- **`jev always` (and `autoModelJev: always`):** ask Jev on every turn, not only when the rules are unsure. It sends every message you type (still never one that looks like a key) and every turn waits for the answer, a second or so at most, so it is a choice, not the default. Jev may see a clear case differently, but never lowers the rules' level by more than one step (reason code `step-floor`).
- The `/nexus` status and the command's own answer follow your pick, and say what each setting costs.

## 0.7.2 (2026-11-18)

- **A repo's `.env` is no longer trusted like yours:** the `.env` in the folder `claude-nexus` starts from may belong to a repo you did not write. In 0.7.0 and 0.7.1 it could add hosts the Jev key may go to (`NEXUS_JEV_HOSTS`) and outranked `~/.claude/nexus/.env`, so it could also replace your key with its own. Now the order is `NEXUS_ENV_FILE`, then `~/.claude/nexus/.env`, then the folder's `.env` last; the folder's file cannot set `NEXUS_JEV_HOSTS` or `NEXUS_ENV_FILE`, and your own files and the shell always win. It can still supply a key when you have none anywhere else, so keep the key in `~/.claude/nexus/.env` if you open projects you do not trust. If you use Jev, update.

## 0.7.1 (2026-11-18)

- **Security hardening for the Jev key:** in 0.7.0 the router's control endpoint could name which environment variable the router read for the Jev key and which address it was sent to, so a caller holding the control token could have aimed any variable of the router's environment at any https host. Now the router is given only the variables a Jev key can live in (`CMD_API_KEY`, `TYPESAFE_API_KEY`, `JEV_API_KEY` or a `NEXUS_JEV_*` name), never the rest of the environment, and the key can only be sent to `api.commandcode.ai`, `api.typesafe.ai` or hosts listed in `NEXUS_JEV_HOSTS`. Both lists are fixed when `claude-nexus` starts, so the plugin's settings and the control endpoint cannot widen them. The control token is random and known only to the plugin, so this was hardening, not a remote hole. If you use Jev, update.
- **A refused Jev setting no longer costs the rest:** the router applies the mode and model settings and reports why a Jev setting was refused; `/automodel-nexus` shows it as `Jev: a setting was refused (...)`.

## 0.7.0 (2026-11-18)

- **Optional Jev classifier for Auto Model (off by default):** with `autoModelJev` set to `gray`, when the built-in rules are unsure about a message, Auto Model asks [Jev](https://docs.typesafe.ai/introduction) (TypeSafe), through any service that takes the same request (by default Command Code), to judge it light, medium or heavy. Nothing depends on it: with the setting off, without a key, or on any failure (a timeout, an error, a rejected key, an unsure answer) the rules decide exactly as before. Only the message you typed is sent (cut to about 2,500 characters; never tool output, files, the system prompt or history), and never one that looks like it holds a key or token. One question per turn, `autoModelJevTimeoutMs` (1500) at most; three failures in a row pause it for five minutes. `/automodel-nexus` shows how it is doing and says so plainly when the key is missing.
- **`.env` files for `claude-nexus`:** the key is read from the shell or from a `.env` file, looked for at `NEXUS_ENV_FILE`, in the folder `claude-nexus` was started from, and in `~/.claude/nexus/.env`. Values from a `.env` go to the router only; the `claude` process and its tools never receive them. The shell's own value wins, and an empty value is none.
- **Settings:** `autoModelJev`, `autoModelJevUrl`, `autoModelJevKeyEnv`, `autoModelJevModel`, `autoModelJevTimeoutMs`, `autoModelJevMinConfidence`. The key itself is never a setting.

## 0.6.10 (2026-11-18)

- **Auto Model records what a request looks like:** each routed request keeps counts and kinds only (messages, tools, output cap, what the last message is made of) and the model Claude Code asked for. `/automodel-nexus recent` shows them on a second line under each decision, so a person's turn can be told from a background call. Never prompt text.

## 0.6.9 (2026-11-18)

- **Auto Model keeps short questions light:** a slash command's own wrapper and output (`<command-name>`, `<local-command-stdout>` and the like) no longer count as the person's request, so `/automodel-nexus` output does not push the next question up a tier.
- **`big-context` only lifts a message that is not short:** a question under 200 characters stays LIGHT in a long conversation. The guard that keeps Haiku off a very large prompt is unchanged.

## 0.6.8 (2026-11-18)

- **Auto Model:** the name the person sees. The settings are `autoModel`, `autoModelOpus`, `autoModelSonnet`, `autoModelHaiku`, `autoModelMaxEscalations` and `autoModelPrices`; the `/nexus` status, the command's description and the HUD use it too. The command stays `/automodel-nexus`. Behaviour is unchanged.

## 0.6.7 (2026-11-18)

- **Claude Mode:** in a `claude-nexus` session on the Claude route, the router picks the model per request: light questions to Haiku, everyday coding to Sonnet, deep reasoning to Opus. Escalation moves a turn up only on measured failures; a failed request is retried on another model before any output reaches Claude Code.
- **`/automodel-nexus`:** `auto`, `opus`, `sonnet`, `haiku`, `off`, `recent` or `reset`; the pick is remembered across sessions. The status shows counts per tier, escalations, fallbacks and an estimated cost.
- **HUD badge:** the header shows `mode auto·sonnet` (the tier of the last request) or `mode opus` when forced; nothing when off or in a plain session.
- **Settings:** `autoModel`, `autoModelOpus`, `autoModelSonnet`, `autoModelHaiku`, `autoModelMaxEscalations`, `autoModelPrices`. A value set under an earlier name is not read: set it again.

## 0.6.6 (2026-10-12)

- **Resume behind the router:** when a `claude-nexus` session ends, Claude Code's own hint still says `claude --resume <id>` (the name is fixed in Claude Code), and plain `claude` bypasses the router. `claude-nexus` now prints `claude-nexus --resume <id>` under it, for the session that ran.

## 0.6.5 (2026-10-12)

- **Provider pane:** each profile is one row, `● 1: Use myhub   Test  Edit  Delete`. Its model, masked key, context window and fallback mark are no longer listed; the route line still names the model in use, and **Edit** shows the rest.

## 0.6.4 (2026-10-12)

- **Model fallback on a hub:** a profile can hand a request whose model fails (connection lost, 404, 408, 429, 5xx) to its other models, tiers below first (opus → sonnet → haiku; sonnet → haiku → opus; haiku → sonnet → opus), each model once; a toast names both. A request the hub refuses as such (400, 401, 403) is not retried. Asked per profile in the `/provider-nexus` form; profiles saved before keep it off until edited.
- **The badge follows `/model`:** `⇄ <profile> · <model>` in the HUD, the pane, `/provider-nexus status` and the switch message name the hub model for the Claude model in use, not always the opus one.

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
