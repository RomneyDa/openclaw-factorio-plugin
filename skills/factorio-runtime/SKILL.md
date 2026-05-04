---
name: factorio-runtime
description: Inspect and safely interact with a running Factorio game through the bundled OpenClaw Factorio runtime mod and local RCON bridge. Use when the user asks about a running Factorio game, inventory, base state, nearby entities/resources, production/research stats, recipes/technologies/prototypes, or bounded in-game actions.
metadata: {"openclaw":{"requires":{"config":["plugins.entries.openclaw-factorio-runtime.enabled"]}}}
---

# Factorio Runtime Skill

Use `factorio_runtime` for live game state/actions. Use `factorio_status` when connectivity/setup is uncertain. Use `factorio_setup` only for setup/config help; it edits local Factorio files and requires a Factorio restart.

Leave `player` empty for local single-player; the mod falls back to the first connected/valid player.

## Capability map

Read-only actions:

- `capabilities` — list runtime API groups and bounded limits.
- `players` — list known players, connection state, positions, forces.
- `state` — tick, map difficulty, player state, selected entity, inventory, force/enemy summary.
- `inventory` — main inventory contents.
- `selected_entity` — entity currently selected by the player/cursor.
- `nearby` / `nearby_entities` — entities around player. Optional filters: `radius`, `limit`, `name`, `type`, `force`.
- `resources` — nearby resource entities. Optional `radius`, `limit`.
- `production` / `production_stats` — item/fluid production input/output counts, kills, current research.
- `force_state` — force modifiers and research summary.
- `research` — current research details and progress.
- `technologies` — search force technologies with `query`, `limit`.
- `recipes` — search force recipes with `query`, `limit`.
- `prototypes_search` — search prototype names. Args: `kind` (`item`, `entity`, `fluid`, `recipe`, `technology`), `query`, `limit`.
- `surface_info` — current surface/daytime/pollution-at-player.

Safe write:

- `chat` — print `[OpenClaw] ...` in-game. No confirmation needed.

Mutating actions:

- `craft` — queue hand-crafting: `itemName`/`item`, `count`.
- `give_item` — insert item into player inventory: `itemName`/`item`, `count`.
- `remove_item` — remove item from player inventory: `itemName`/`item`, `count`.
- `place_entity` — create an entity near player: `entityName`/`entity`, `dx`, `dy`.
- `mine_selected` — mine currently selected entity into inventory.
- `destroy_selected` — destroy currently selected entity.
- `move` / `move_player` — teleport by bounded offset: `dx`, `dy`.

## Confirmation policy

By default, ask for explicit user confirmation before every mutating action, then call `factorio_runtime` with `confirmed: true`.

Users can opt out globally with plugin config:

```json
{
  "requireConfirmationForMutatingActions": false
}
```

If this opt-out is configured, mutating actions may be executed without per-action confirmation. Still be careful: read state first, avoid broad/destructive changes unless requested, and explain what you did.

## Workflows

For "what should I do next?":

1. `state`
2. `inventory`
3. `nearby` with radius 30-50
4. `production` if the factory exists
5. `research` / `recipes` as needed
6. Give a practical next step, not a giant plan.

For "how is my base doing?":

1. `state`
2. `production`
3. `nearby` filtered by useful types when relevant (`assembling-machine`, `furnace`, `mining-drill`, `transport-belt`, `inserter`, `resource`).
4. Summarize bottlenecks and immediate actions.

For placing/crafting/moving:

1. Read `state` first.
2. Use `prototypes_search` if unsure of exact prototype names.
3. Confirm with user unless config disables confirmation.
4. Execute the bounded action.
5. Read `state`/`inventory` after if needed and report results.

## Guardrails

Never execute arbitrary Lua or raw RCON for gameplay tasks. Use only `factorio_runtime` / the curated `remote.call("openclaw", ...)` API.

RCON is admin-level access. Do not expose passwords or credentials.

The mod enforces conservative bounds: nearby radius/result limit, placement distance, movement distance, craft count, and item insertion/removal count.

## Troubleshooting

- RCON unavailable: ask user to run `openclaw factorio setup`, restart Factorio, enable `openclaw-runtime` in Mods if prompted, and load the save.
- Remote interface missing: mod is not loaded in current save/runtime; restart Factorio and confirm mod enabled.
- Player lookup fails: retry with `player: ""` for local single-player, or ask for the exact multiplayer player name.
