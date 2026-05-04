# OpenClaw Factorio Plugin

OpenClaw plugin for live Factorio inspection/control through:

- a bundled Factorio mod: `openclaw-runtime`
- local Factorio RCON
- OpenClaw agent tools + `openclaw factorio ...` CLI commands
- a bundled `factorio-runtime` skill

## What agents can do

Read-only capabilities:

- list runtime capabilities and bounded limits
- list players and connection/position/force info
- inspect current player/game state, selected entity, inventory, force/enemy summary
- inspect nearby entities with filters for radius, prototype name, entity type, force, and limit
- inspect nearby resources
- inspect item/fluid production stats, kill stats, research progress
- inspect force state, current research, technologies, recipes, prototypes, and surface info

Safe write:

- print in-game chat messages from OpenClaw

Mutating capabilities:

- queue hand-crafting
- give/remove inventory items
- place entities near the player
- mine or destroy the currently selected entity
- move/teleport the player by a bounded offset

The runtime mod exposes only a curated `remote.call("openclaw", ...)` interface. The skill instructs agents not to run arbitrary Lua.

## Permission model

By default, `factorio_runtime` requires explicit confirmation for mutating actions. Agents should read state first, ask the user to confirm, then retry with `confirmed: true`.

Users who want autonomous action can opt out in plugin config:

```json
{
  "requireConfirmationForMutatingActions": false
}
```

Set this to `false` only for saves where you're comfortable letting OpenClaw craft/place/move/mine/destroy/give/remove without per-action confirmation.

## Install

From a local checkout/archive:

```bash
openclaw plugins install ./openclaw-factorio-plugin
openclaw gateway restart
```

From GitHub:

```bash
openclaw plugins install git:github.com/romneyda/openclaw-factorio-plugin
openclaw gateway restart
```

Enable it if needed:

```bash
openclaw plugins enable openclaw-factorio-runtime
```

## One-command setup

Run:

```bash
openclaw factorio setup
```

This command:

1. copies the bundled `openclaw-runtime_0.1.0.zip` into the default Factorio mods directory
2. edits Factorio `config.ini` to enable local RCON on `127.0.0.1:27015`
3. generates/stores a local RCON password at `~/.openclaw/factorio-runtime-rcon.json` with mode `0600`
4. leaves a config backup at `config.ini.bak-openclaw-rcon` when possible

Then:

1. restart Factorio completely
2. enable `openclaw-runtime` in Factorio's Mods UI if prompted
3. load your save
4. verify:

```bash
openclaw factorio status
openclaw factorio inventory
```

## CLI commands

```bash
openclaw factorio setup
openclaw factorio status
openclaw factorio inventory [player]
openclaw factorio state [player]
openclaw factorio nearby [player] [radius]
openclaw factorio production [player]
openclaw factorio chat "hello from OpenClaw"
openclaw factorio call capabilities
openclaw factorio call players
openclaw factorio call resources "" 50 100
openclaw factorio call prototypes_search item belt 20
openclaw factorio raw '/c rcon.print("ping")'
```

For local single-player, omit `player` or pass an empty string. The mod falls back to the first connected/valid player.

## OpenClaw tools

The plugin registers:

- `factorio_setup` — install mod + configure local RCON
- `factorio_status` — check install/config/RCON status
- `factorio_runtime` — call the curated runtime API

`factorio_runtime` actions:

- Read-only: `capabilities`, `players`, `state`, `inventory`, `selected_entity`, `nearby`, `nearby_entities`, `resources`, `production`, `production_stats`, `force_state`, `research`, `technologies`, `recipes`, `prototypes_search`, `surface_info`
- Safe write: `chat`
- Mutating: `craft`, `give_item`, `remove_item`, `place_entity`, `destroy_selected`, `mine_selected`, `move`, `move_player`

Manifest contracts declare these tools so OpenClaw can discover ownership without loading plugin code.

## Configuration

Optional plugin config under `plugins.entries.openclaw-factorio-runtime.config`:

```json
{
  "host": "127.0.0.1",
  "port": 27015,
  "credentialPath": "~/.openclaw/factorio-runtime-rcon.json",
  "modsDir": "~/Library/Application Support/factorio/mods",
  "factorioConfigPath": "~/Library/Application Support/factorio/config/config.ini",
  "requireConfirmationForMutatingActions": true
}
```

You can also set env vars for CLI/runtime overrides:

```bash
export FACTORIO_RCON_HOST=127.0.0.1
export FACTORIO_RCON_PORT=27015
export FACTORIO_RCON_PASSWORD='...'
```

## Security notes

- Factorio RCON is admin-level. This plugin binds local setup to `127.0.0.1` by default.
- Do not expose the RCON port publicly.
- Prefer generated credentials stored in `~/.openclaw/factorio-runtime-rcon.json`.
- Agents should use `factorio_runtime`, not arbitrary raw RCON/Lua, for gameplay tasks.

## Publishing notes

This is a native OpenClaw plugin. Required package metadata lives in `package.json`, and plugin manifest metadata lives in `openclaw.plugin.json`.
