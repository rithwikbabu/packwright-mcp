# CLI reference

The `packwright-mcp` executable serves MCP by default and also exposes operator-friendly versions of diagnostics, setup, datapack validation, testing, and build operations. The paired visual workflow is currently MCP-first; use the twelve visual tools rather than expecting separate visual CLI subcommands.

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

Reports Node, workspace read/write, Java 25, server-validation cache, optional client-asset cache, and external-validator readiness. Java and the server cache are required by default validation, every build, and GameTest; client assets and Spyglass remain optional. Required Node/workspace failures produce exit code 1.

## `setup-version`

```text
packwright-mcp setup-version 26.2 \
  --accept-minecraft-eula \
  [--client-assets] \
  --workspace /absolute/path/to/datapacks \
  [--json]
```

Requires explicit human EULA acceptance and Java 25. Downloads only allow-listed official Mojang metadata/artifacts, verifies the server jar SHA-1, and prepares cache reports. Only version `26.2` is accepted. Offline mode prevents downloads.

`--client-assets` explicitly opts into caching the official client jar and asset index declared by the same manifest. Packwright verifies both SHA-1 values and sizes before reporting client-profile readiness. The option does not fetch every object named by the asset index, install or launch Minecraft, or redistribute client files. In v0.3 it is a setup/readiness signal, not a built-in asset resolver; compilation, rendering, and validation do not load built-in asset content from this cache.

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
|  `2` | Default validation, build, or test requires Java 25 or a prepared Minecraft 26.2 cache.                         |
