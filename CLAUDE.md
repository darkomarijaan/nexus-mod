# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Nexus is a Claude Code **mod** (plugin, marketplace `nexus-mod`, plugin `nexus`) written against the Claude Code mod API (`import ... from 'claude-code'`, Claude Code ≥ 2.1.296). Two halves:

- **Hooks** (`hooks/`, TypeScript + JSX with the `h` factory): run inside Claude Code. `hooks/hooks.json` loads a single module, `register.tsx`.
- **Bridge** (`bridge/`, plain Node `.mjs`, no dependencies): processes outside Claude Code. Includes the `claude-nexus` launcher, the local provider router (`claude-nexus.mjs`, `router.mjs`, pure logic in `route-core.mjs`), and the browser-preview server (`server.mjs`). `bin/claude-nexus(.cmd)` are thin wrappers that resolve the bridge relative to themselves.

## Commands

```
claude plugin test .          # all hook tests (tests/*.test.ts), ~20 s; no single-file filter exists
claude plugin test . 2>&1 | grep -A60 "leanmode.test"   # read one file's results
claude plugin validate .      # manifest + types contract; must pass
node --test bridge/*.test.mjs # bridge/router/launcher tests (node:test; a bare bridge/ fails on Node 24)
node --test bridge/route-core.test.mjs                  # a single bridge test file
```

Type-check: no local TypeScript install. The repo `tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which Claude Code generates when the plugin loads (git-ignored). For a standalone check, point a temporary tsconfig (strict, `noUncheckedIndexedAccess`, `jsx: react`, `jsxFactory: h`) at the `plugin-authoring/types/claude-code.d.ts` that Claude Code bundles under its temp `bundled-skills/<version>/` folder, plus `hooks`, `types`, `tests`, then run `npx -y -p typescript@5.6.3 tsc -p <that tsconfig>`.

Trying changes in a real session: the installed copy lives in `~/.claude/plugins/cache/nexus-mod/nexus/<version>`. After editing, run `claude plugin update nexus@nexus-mod` (or `/reload-plugins`), or start a session with `claude --plugin-dir <this folder>` to load the working tree directly.

Release zip (`nexus-mod.zip`, git-ignored, built only when asked): `Compress-Archive -Path .claude-plugin, bin, bridge, hooks, types, tests, README.md, CHANGELOG.md, tsconfig.json -DestinationPath nexus-mod.zip`.

## Architecture

- **`hooks/register.tsx` is the only module that touches `$`** (the engine). Every sibling file (`config`, `lean`, `leanmode`, `provider`, `shield`, `secrets`, `insights`, `theme`, `design`, `util`, `state`) is pure logic with unit tests. Keep it that way: new behaviour goes into a pure sibling plus thin wiring in `register.tsx`.
- `register.tsx` is ordered in sections (`// ═══ 1. Host`, `2. Workspace`, `3. Guards`, `4. Delivery`, `5. Layout`, `Registration`). Everything is registered inside `export const register: Register = (on, options) => { ... }`. `cfg = readConfig(options)` turns `userConfig` from `.claude-plugin/plugin.json` into `NexusConfig` (`hooks/config.ts`).
- **State** uses atoms: `atom({ plugin: 'nexus', key } as const, initial)` with `read`/`update`. Every atom key **must** be declared in `types/index.d.ts` under `interface PluginState { nexus: {...} }`, or `claude plugin validate` fails. State that must survive sessions is mirrored to `$.store` (e.g. theme key `theme`, lean pick key `lean`) and loaded in `session.start`.
- **Settings**: a new option needs three places: `userConfig` in `.claude-plugin/plugin.json`, `NexusConfig` plus `readConfig` in `hooks/config.ts`, and the `/nexus` status text (`statusText`). Also update README's settings table.
- **Commands** are declared in the `COMMANDS` array and handled by `on('command.run', { command: '<name>' }, ...)`. All names end in `-nexus` so none collides with a built-in. `immediate: true` lets a command run mid-turn.
- **System prompt**: `on('prompt.compose')` appends one section, id `nexus:delivery`, built by `deliveryRules` (Executive Summary, lean-mode rules, Design Lens). It is recomposed for every request, so setting changes apply at the next turn.
- **HUD**: drawn by `on('ui.render', { component: 'AbovePrompt' })`. Icons and colours come from the active skin in `hooks/theme.ts` (each skin has Unicode or ASCII `ThemeIcons`).

## Mod API gotchas found in this repo

- `$.prompt.submit` called from inside a `command.run` hook is refused by the host ("it would wait on the turn this hook is holding"). Defer it: `$.clock.after(0, () => void $.prompt.submit(...))`. In tests, drive it with `mock.clock(on)` + `clock.advance(1)` / `clock.settle()`.
- On Windows the host hands `fs.write` hooks backslash paths (`C:\app\...`) even when the plugin wrote forward slashes. Normalise in test assertions.
- Hook tests: the kit is `import { describe, expect, mock, test } from 'claude-code/testing'`; `test(name, { options: {...userConfig} }, async ($, on) => ...)`. `on(...)` in a test answers *beneath* the plugin (it plays the engine). Turn off unrelated modules in `options` (see the `BASE`/`QUIET` objects at the top of test files). Use `mock.store(on)` for `$.store`. Answer `AskUserQuestion` dialogs with `on('tool.call', { tool: 'AskUserQuestion' }, ...)`.
- `claude plugin validate` prints many `gating hook without .catch` lines. Those are pre-existing notes, not failures. Only `✘` lines fail it.

## Conventions

- User-facing strings (command output, toasts, dialogs) are English. The repo owner chats in Indonesian.
- Versions: `.claude-plugin/plugin.json` `version`, the "Version x.y.z" line at the top of README, and a `CHANGELOG.md` entry move together. Releases are tagged `nexus--v<version>` on GitHub with the zip attached.
- Designs and plans live in `docs/superpowers/specs/` and `docs/superpowers/plans/` (written in Indonesian). README's Roadmap lists what is next.
- Commits end with a `Co-Authored-By:` trailer.
