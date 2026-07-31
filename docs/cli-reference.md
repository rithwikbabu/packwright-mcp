# CLI reference

The `packwright-mcp` executable serves MCP by default and also exposes operator-friendly versions of diagnostics, setup, official-client capture, datapack validation, testing, and build operations. The paired visual workflow is MCP-first; `capture` is the one visual operation with a standalone CLI mirror, while the complete workflow remains available through thirteen visual tools.

## Global options

Global options may be passed with any command:

| Option                           | Behavior                                       |
| -------------------------------- | ---------------------------------------------- |
| `--workspace <absolute-path>`    | Select the required datapack workspace.        |
| `--java <executable>`            | Override `PACKWRIGHT_JAVA`.                    |
| `--cache-dir <absolute-path>`    | Override the Packwright cache directory.       |
| `--read-only` / `--no-read-only` | Enable or override environment read-only mode. |
| `--offline` / `--no-offline`     | Enable or override environment offline mode.   |
| `--json`                         | Emit JSON from non-server commands.            |
| `--help`                         | Show command help.                             |
| `--version`                      | Show the Packwright version.                   |

CLI options take precedence over environment variables. See [Configuration](configuration.md).

## `serve`

```text
packwright-mcp serve --workspace /absolute/path/to/datapacks
```

Starts the local stdio MCP server. Omitting the subcommand has the same effect. Protocol JSON-RPC is written to stdout; server errors are written to stderr.

## `doctor`

```text
packwright-mcp doctor --workspace /absolute/path/to/datapacks [--json]
```

Reports Node, workspace read/write, Java 25, server-validation cache, optional client-asset cache, official-client capture runtime/graphical-session readiness, and external-validator readiness. Java and the server cache are required by default validation, every build, and GameTest; client capture and Spyglass remain optional. Required Node/workspace failures produce exit code 1.

## `setup-version`

```text
packwright-mcp setup-version 26.2 \
  --accept-minecraft-eula \
  [--client-assets] \
  [--client-capture] \
  --workspace /absolute/path/to/datapacks \
  [--json]
```

Requires explicit human EULA acceptance and Java 25. The default path downloads only allow-listed official Mojang metadata/artifacts, verifies the server jar SHA-1, and prepares cache reports. Client-capture setup additionally downloads the explicitly pinned Fabric components described below. Only version `26.2` is accepted. Offline mode prevents downloads.

`--client-assets` explicitly opts into caching the official client jar and asset index declared by the same manifest. Packwright verifies both SHA-1 values and sizes before reporting client-profile readiness. It does not fetch every asset object or make client capture ready.

`--client-capture` implies `--client-assets` and prepares the complete platform-specific launcher runtime: every indexed asset object, required Mojang libraries and native classifiers, and Packwright-pinned Fabric Loader `0.19.3` plus its required libraries. Packwright writes a content-addressed runtime manifest and verifies all artifacts before reporting readiness. This is a substantial download. The command does not launch Minecraft, install a pack, or redistribute any Mojang/Fabric artifact. It must be run manually before the MCP `visual_capture` tool; offline mode prevents missing downloads.

Current official-client capture additionally requires Java 25 and an interactive macOS graphical session. `doctor` reports `minecraft_client_capture` as optional and explains any missing runtime, capture-mod, Java, or graphical-session prerequisite.

## `capture`

```text
packwright-mcp capture <project-id> \
  --run <sha256> \
  [--revision <sha256>] \
  --proposal-sha256 <sha256> \
  --confirm \
  [--timeout-ms <30000-600000>] \
  [--width <640-1920>] \
  [--height <360-1080>] \
  [--gui-scale <0-8>] \
  [--representation-json <json>] \
  [--display-settling-ticks <2-40>] \
  [--include-scale-reference-views] \
  [--include-debug-hitbox-views] \
  --workspace /absolute/path/to/datapacks \
  [--json]
```

Mirrors the MCP `visual_capture` operation. It launches the pinned official Minecraft 26.2 client only after all exact run/revision/proposal/representation preconditions and setup checks pass. The defaults are a five-minute timeout, 1280×720 framebuffer, GUI scale 2, and no augmented views. Human-readable output prominently prints the exact representation strategy and capability, its disclosure, and the proposal-binding status and reason before hashes, evidence counts, measurements, and artifact URIs. `SIMULATED`, `REPLACEMENT`, and `CAPTURE_ONLY` are therefore visible even when the framebuffer run passed; capture-only evidence reviews a declared representation but does not prove that the current compiler proposal implements it and cannot authorize commit. A preflight result that has not bound a representation prints these fields as `UNAVAILABLE` instead of silently omitting them. `setup_required` uses exit code 2; capture failure, timeout, or cancellation uses exit code 1.

Required first-person views are `first_person_vanilla`: exact stock Minecraft gameplay composition with no Packwright-injected arm. `--include-scale-reference-views` adds injected-arm `first_person_scale_reference` captures. `--include-debug-hitbox-views` adds supported entity/placeable `debug_hitbox_reference` captures. Those opt-ins, bare-head and same-frame injected comparisons, non-ordinary scale aids, and automatically paired empty-subject `measurement_control` frames are supplemental `augmented_qa_reference` evidence in a separate generic QA sheet and cannot replace any required view or affect capture authority. Ordinary in-world block scale context—and an armor stand when it is the declared headwear subject—remains authoritative. The corresponding MCP booleans default to `false`.

Omit `--representation-json` for the existing connected `held_item`/`gui_item` item stack. That item representation contains exactly one canonical proposal-bound rendered state. For `block`, `head_wearable`, `entity_model`, or `placeable`, supply the same strict tagged representation accepted by MCP: `native_block_state`, `block_display`, `equippable_head`, `native_entity`, `native_placeable_block`, `native_placeable_entity`, or `display_rig`. The JSON accepts only allow-listed primitives, block states, item stacks/components, variants/equipment, display transforms, and bounded interactions. Protocol v3 accepts static display nodes only, rejects block atlas-phase samples, requires exact `idle`/`walk`/`attack` states for simulated entity rigs, and requires a renderer-observable default zombie for native core poses. Variant-capable entities require an exact registry variant. Native placeables are floor-only and native blocks bind cardinal `facing`; wall/ceiling attachments use exact display-rig origins. Headwear `asset_id`/fallback/overlay/chest-stack declarations must match the actual `minecraft:equippable` component. `--display-settling-ticks` is accepted only with `display_rig` or `block_display`, defaults to two, and is capped at 40. The representation has no path, command, function, save, mod, credential, or executable field.

The command stages the packs in a disposable studio and never touches a user save. Client capture is `full` for `gui_item`, `limited` for one-handed `held_item`, `block`, `head_wearable`, `entity_model`, and `placeable`, and `unsupported` for `armor` and `projectile`. A native block-state replacement remains an existing vanilla block identity; `block_display` and display rigs are explicitly simulated. Headwear requires an actually equipped `minecraft:equippable` head item. Native entity capture is limited to supported existing vanilla types/variants/components; arbitrary native entity geometry is unsupported.

## `validate`

```text
packwright-mcp validate <project> \
  --workspace /absolute/path/to/datapacks \
  [--no-vanilla] [--no-spyglass] [--json]
```

`<project>` is relative to the workspace. Structural checks always run. By default, Packwright also uses Java 25 and the prepared Minecraft 26.2 cache to parse every logical `.mcfunction` command with vanilla's real dispatcher, loaded registries, and component codecs. Missing setup returns `setup_required`, and invalid commands produce authoritative diagnostics. `--no-vanilla` explicitly selects reduced structural validation when vanilla setup is unavailable; it is not proof that Minecraft accepts the commands.

When an external command is configured, Spyglass also runs by default; `--no-spyglass` disables it for that invocation. Invalid packs produce exit code 1. Human-readable command diagnostics identify the original physical line and show any heuristic registry suggestion separately:

```text
spell/chain/cast.mcfunction:12
Unknown particle `minecraft:electric`
Did you mean `minecraft:electric_spark`?
```

## `test`

```text
packwright-mcp test <project> \
  --workspace /absolute/path/to/datapacks \
  [--test <namespace:id...>] \
  [--timeout-ms <positive-integer>] \
  [--json]
```

Runs the staged pack in a fresh disposable vanilla universe. Each `--test` value is an exact `test_instance` resource ID, not a datapack function ID; without it, the vanilla runner selects its default test set. The default and maximum timeout is 300,000 ms; the budget covers mandatory command prevalidation and the subsequent GameTest run together. Test failures/timeouts use exit code 1, while missing Java/cache setup uses exit code 2.

## `build`

```text
packwright-mcp build <project> \
  --workspace /absolute/path/to/datapacks \
  [--output <workspace-relative.zip>] \
  [--overwrite --expected-sha256 <digest>] \
  [--json]
```

Runs structural checks and mandatory vanilla-backed command validation, then creates a deterministic ZIP. Build has no `--no-vanilla` option: Java 25, the prepared 26.2 cache, and commands accepted by Minecraft are required before packaging. The default output is `<project>.zip` beneath the workspace and outside the pack. Replacing an existing output requires both `--overwrite` and its current SHA-256. Validation/build failures produce exit code 1.

The CLI `build` command remains datapack-only for backward compatibility. Use the MCP `project_build` tool for an attached visual project; it emits separate deterministic datapack and resource-pack ZIPs.

## Exit codes

| Code | Meaning                                                                                                         |
| ---: | --------------------------------------------------------------------------------------------------------------- |
|  `0` | Command completed successfully.                                                                                 |
|  `1` | Invalid input, failed required doctor check, invalid pack, failed validation/build, or other operational error. |
|  `2` | Default validation, build, test, or client capture requires Java 25 or the corresponding prepared 26.2 cache.   |
