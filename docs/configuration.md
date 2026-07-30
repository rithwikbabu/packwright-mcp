# Configuration

Packwright must be given one absolute workspace directory. Every pack and resource path is resolved beneath that boundary.

## Precedence

For a setting available as both a CLI option and an environment variable, the CLI option wins. Environment variables override built-in defaults.

| CLI option                    | Environment variable          | Purpose                                                                                  |
| ----------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------- |
| `--workspace <absolute-path>` | `PACKWRIGHT_WORKSPACE`        | Required workspace containing datapack projects.                                         |
| `--java <executable>`         | `PACKWRIGHT_JAVA`             | Java executable used for setup checks and vanilla GameTests.                             |
| `--cache-dir <absolute-path>` | `PACKWRIGHT_CACHE_DIR`        | Local cache for version metadata, the verified server jar, and generated reference data. |
| `--read-only`                 | `PACKWRIGHT_READ_ONLY=true`   | Disable all mutating MCP tools.                                                          |
| `--offline`                   | `PACKWRIGHT_OFFLINE=true`     | Forbid network access, including operator-invoked setup.                                 |
| —                             | `PACKWRIGHT_SPYGLASS_COMMAND` | Opt in to an operator-installed, trusted Spyglass executable; unset by default.          |

`PACKWRIGHT_WORKSPACE` is marked required in the MCP Registry metadata. A client may instead supply `--workspace`; either way, startup fails closed when the value is missing, relative, inaccessible, or not a directory.

`PACKWRIGHT_SPYGLASS_COMMAND` is not accepted from MCP tool input. Configure it only after independently reviewing and installing the external executable. Packwright accepts only the compatibility-pinned Spyglass `0.4.65` version reported by `<command> --version`; other or unversioned executables remain not-ready. Packwright does not install, update, or enable Spyglass automatically.

## Workspace layout

The workspace is a container for one or more datapacks, not a Minecraft world:

```text
/absolute/datapacks-workspace/
├── combat-overhaul/
│   ├── pack.mcmeta
│   └── data/
└── utility-functions/
    ├── pack.mcmeta
    └── data/
```

MCP requests identify packs and resources relative to this directory. Absolute request paths, `..` traversal, encoded traversal, and symlinks that resolve outside the workspace are rejected. A pack root is recognized by its `pack.mcmeta`; resource operations cannot escape that root.

## Read-only sessions

Use read-only mode when an MCP client only needs inspection, lookup, or review:

```json
{
  "mcpServers": {
    "packwright": {
      "command": "npx",
      "args": ["-y", "@rithwikbabu/packwright-mcp@0.1.0"],
      "env": {
        "PACKWRIGHT_WORKSPACE": "/absolute/path/to/datapacks",
        "PACKWRIGHT_READ_ONLY": "true"
      }
    }
  }
}
```

In read-only mode, create, upsert, delete, and build operations are disabled. Inspection, reading, validation, lookup, and prompts remain available. Vanilla testing may create temporary state outside the workspace but never changes a pack.

## Offline behavior

The MCP server never silently accesses the network. Normal authoring, structural validation, lookup against an existing cache, build, and testing against an existing cache can run offline.

`PACKWRIGHT_OFFLINE=true` additionally prevents the operator-only `setup-version` command from downloading metadata or artifacts. When required local data is absent, Packwright returns `setup_required` rather than falling back to the network.

## Resource limits

The v1 safety limits are:

| Limit                            |   Value |
| -------------------------------- | ------: |
| Files in one scan or build       |  20,000 |
| Total bytes in one scan or build | 512 MiB |
| One text write                   |   4 MiB |
| One MCP payload                  |   1 MiB |

Payloads that can be safely shortened include explicit truncation metadata. Operations that cannot be completed within a safety bound fail without a partial write.

## Diagnostics and stdout

Under stdio transport, stdout is reserved for MCP JSON-RPC messages. Human diagnostics and logs are sent to stderr. Do not wrap the server with tooling that writes banners or status messages to stdout.
