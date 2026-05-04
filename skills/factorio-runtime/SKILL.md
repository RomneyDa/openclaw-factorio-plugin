---
name: factorio-runtime
description: Inspect and safely interact with a running Factorio game through the bundled OpenClaw Factorio runtime mod and local RCON bridge. Use when the user asks about a running Factorio game, inventory, base state, nearby entities, production stats, or safe in-game actions.
metadata: {"openclaw":{"requires":{"config":["plugins.entries.openclaw-factorio-runtime.enabled"]}}}
---

# Factorio Runtime Skill

Use the `factorio_runtime` tool for live Factorio state. Use `factorio_status` when connectivity or setup is uncertain. Use `factorio_setup` only when the user wants setup/configuration help; it edits local Factorio files and requires a Factorio restart.

## Runtime API

`factorio_runtime` supports these actions:

- Read-only: `state`, `inventory`, `nearby` / `nearby_entities`, `production` / `production_stats`
- Safe write: `chat`
- Mutating actions requiring user confirmation first: `place_entity`, `craft`, `move` / `move_player`

Leave `player` empty for local single-player; the mod falls back to the first connected/valid player. Provide a name for multiplayer/server games when known.

## Safety rules

Never execute arbitrary Lua or raw RCON for gameplay tasks.

Only use the curated runtime interface exposed through `factorio_runtime` / `remote.call("openclaw", ...)`.

Prefer read-only calls. Ask for explicit user confirmation before actions that modify the game, including placing entities, crafting items, teleporting/moving the player, modifying structures, altering research, combat, or logistics.

The `chat` action is considered safe and does not require confirmation.

## Read-only workflow

For vague requests like "how is my base doing?":

1. Call `factorio_status` if you have not used the runtime successfully in this session.
2. Call `factorio_runtime` with `action: "state"`.
3. Add `production` when production/research/base health is relevant.
4. Add `nearby` when location context matters.
5. Summarize clearly; mention blockers if RCON/mod setup is incomplete.

## Action workflow

For requests like "place an assembler":

1. Read current `state` first.
2. Infer only small local offsets when safe; otherwise ask for the target.
3. Ask for confirmation before the mutating action.
4. Execute the curated action after confirmation.
5. Report the result.

## Troubleshooting

- If RCON is unavailable: ask the user to run `openclaw factorio setup`, restart Factorio, enable `openclaw-runtime` in Mods if prompted, and load the save.
- If the remote interface does not exist: the mod is not loaded in the current save/runtime; restart Factorio and confirm the mod is enabled.
- If player lookup fails: retry with `player: ""` for local single-player, or ask for the exact multiplayer player name.
- RCON is admin-level access. Do not expose passwords or credentials.
