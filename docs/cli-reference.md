# CLI reference

The `packwright-mcp` executable serves MCP by default and also exposes operator-friendly versions of diagnostics, setup, validation, testing, and build operations.

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

Reports Node, workspace read/write, Java 25, Minecraft cache, and external-validator readiness. Java, cache, and Spyglass are informational unless needed for the requested workflow; required Node/workspace failures produce exit code 1.

## `setup-version`

```text
packwright-mcp setup-version 26.2 \
  --accept-minecraft-eula \
  --workspace /absolute/path/to/datapacks \
  [--json]
```

Requires explicit human EULA acceptance and Java 25. Downloads only allow-listed official Mojang metadata/artifacts, verifies the server jar SHA-1, and prepares cache reports. Only version `26.2` is accepted. Offline mode prevents downloads.

## `validate`

```text
packwright-mcp validate <project> \
  --workspace /absolute/path/to/datapacks \
  [--no-spyglass] [--json]
```

`<project>` is relative to the workspace. Built-in validation always runs. When an external command is configured, Spyglass runs by default; `--no-spyglass` disables it for that invocation. Invalid packs produce exit code 1.

## `test`

```text
packwright-mcp test <project> \
  --workspace /absolute/path/to/datapacks \
  [--test <namespace:id...>] \
  [--timeout-ms <positive-integer>] \
  [--json]
```

Runs the staged pack in a fresh disposable vanilla universe. Each `--test` value is an exact `test_instance` resource ID, not a datapack function ID; without it, the vanilla runner selects its default test set. The default and maximum timeout is 300,000 ms; the CLI accepts a positive millisecond value. Test failures/timeouts use exit code 1, while missing Java/cache setup uses exit code 2.

## `build`

```text
packwright-mcp build <project> \
  --workspace /absolute/path/to/datapacks \
  [--output <workspace-relative.zip>] \
  [--overwrite --expected-sha256 <digest>] \
  [--json]
```

Validates and creates a deterministic ZIP. The default output is `<project>.zip` beneath the workspace and outside the pack. Replacing an existing output requires both `--overwrite` and its current SHA-256. Validation/build failures produce exit code 1.

## Exit codes

| Code | Meaning                                                                                                   |
| ---: | --------------------------------------------------------------------------------------------------------- |
|  `0` | Command completed successfully.                                                                           |
|  `1` | Invalid input, failed required doctor check, invalid pack, failed test/build, or other operational error. |
|  `2` | `test` requires Java 25 or a prepared Minecraft 26.2 cache.                                               |
