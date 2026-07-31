# Configuration

Packwright must be given one absolute workspace directory. Every datapack, resource pack, paired-project manifest, imported workspace texture, and build output is resolved beneath that boundary.

## Precedence

For a setting available as both a CLI option and an environment variable, the CLI option wins. Environment variables override built-in defaults.

| CLI option                    | Environment variable          | Purpose                                                                           |
| ----------------------------- | ----------------------------- | --------------------------------------------------------------------------------- |
| `--workspace <absolute-path>` | `PACKWRIGHT_WORKSPACE`        | Required workspace containing datapacks and optional sibling resource packs.      |
| `--java <executable>`         | `PACKWRIGHT_JAVA`             | Java executable used for setup checks and vanilla GameTests.                      |
| `--cache-dir <absolute-path>` | `PACKWRIGHT_CACHE_DIR`        | Local cache for verified Minecraft artifacts, reports, and immutable visual runs. |
| `--read-only`                 | `PACKWRIGHT_READ_ONLY=true`   | Disable workspace mutations; cached visual drafts remain available.               |
| `--offline`                   | `PACKWRIGHT_OFFLINE=true`     | Forbid network access, including operator-invoked setup.                          |
| —                             | `PACKWRIGHT_SPYGLASS_COMMAND` | Opt in to an operator-installed, trusted Spyglass executable; unset by default.   |

`PACKWRIGHT_WORKSPACE` is marked required in the MCP Registry metadata. A client may instead supply `--workspace`; either way, startup fails closed when the value is missing, relative, inaccessible, or not a directory. The cache and workspace must be separate directory trees: neither may contain the other, including through a symlink alias. `doctor` reports this as the required `workspace_cache_separation` check.

`PACKWRIGHT_SPYGLASS_COMMAND` is not accepted from MCP tool input. Configure it only after independently reviewing and installing the external executable. Packwright accepts only the compatibility-pinned Spyglass `0.4.65` version reported by `<command> --version`; other or unversioned executables remain not-ready. Packwright does not install, update, or enable Spyglass automatically.

## Workspace layout

The workspace is a container for packs, not a Minecraft world. Datapack-only projects remain valid, while an attached visual project adds a sibling resource pack and association manifest:

```text
/absolute/packwright-workspace/
├── firestaff-data/
│   ├── pack.mcmeta
│   └── data/
├── firestaff-assets/
│   ├── pack.mcmeta
│   └── assets/
└── .packwright/
    └── projects/
        └── firestaff.json
```

MCP requests identify packs and resources relative to this directory. Absolute request paths, `..` traversal, encoded traversal, and symlinks that resolve outside the workspace are rejected. A pack root is recognized by its `pack.mcmeta`; resource operations cannot escape that root. A visual project requires distinct sibling pack paths and records Minecraft version `26.2`, datapack format `107.1`, resource-pack format `88.0`, and target `vanilla`.

Immutable visual drafts are not project files. They live under `<PACKWRIGHT_CACHE_DIR>/visual-runs/`, and the active-head index lives below `<PACKWRIGHT_CACHE_DIR>/visual-project-state/<workspace-id>/`. State, resource resolution, and mutation locks use a hash of the canonical workspace root, so workspaces sharing one global cache cannot see each other's active heads. v0.3 keeps exactly one active workflow head per paired project, not one per asset or run; omitted IDs select it and `project_build` always builds it. Treat that cache as potentially sensitive because it can contain creative prompts, provenance, textures, compiled proposals, and previews.

## Read-only sessions

Use read-only mode when an MCP client only needs inspection, lookup, or review:

```json
{
  "mcpServers": {
    "packwright": {
      "command": "npx",
      "args": ["-y", "@rithwikbabu/packwright-mcp@0.3.0"],
      "env": {
        "PACKWRIGHT_WORKSPACE": "/absolute/path/to/datapacks",
        "PACKWRIGHT_READ_ONLY": "true"
      }
    }
  }
}
```

In read-only mode, workspace create, upsert, delete, attach, commit, and build operations are disabled. Inspection, reading, validation, lookup, and prompts remain available. Visual draft, compile, render, and repair operations may still create immutable artifacts in the configured cache but cannot install them into either pack. Vanilla testing may create temporary state outside the workspace but never changes a pack.

## Offline behavior

The MCP server never silently accesses the network. Normal authoring, visual drafting/compilation/rendering, structural validation, lookup against an existing cache, build, and testing against an existing cache can run offline. No visual generator provider is built in.

`PACKWRIGHT_OFFLINE=true` additionally prevents the operator-only `setup-version` command from downloading metadata or artifacts. When required local data is absent, Packwright returns `setup_required` rather than falling back to the network.

The optional `setup-version --client-assets` step uses the same cache and offline policy. It stores the manifest-verified 26.2 client jar and asset index only when explicitly selected. In v0.3 this is setup/readiness data, not a built-in texture/model resolver; compilation, rendering, and validation do not load built-in asset content from it. Custom external dependencies must exist in the sibling resource pack.

## Resource limits

The v0.3 safety limits are:

| Limit                            |   Value |
| -------------------------------- | ------: |
| Files in one scan or build       |  20,000 |
| Total bytes in one scan or build | 512 MiB |
| One text write                   |   4 MiB |
| One MCP payload                  |   1 MiB |

Visual-specific limits are:

| Limit                         |                          Value |
| ----------------------------- | -----------------------------: |
| One imported PNG              |                          8 MiB |
| PNG dimensions                | 4,096 × 4,096 maximum per axis |
| PNG pixels / decoded bytes    |            16,777,216 / 64 MiB |
| One visual run JSON artifact  |                          4 MiB |
| One compiled draft artifact   |           2,048 files / 64 MiB |
| One visual commit transaction |             512 files / 64 MiB |
| Paired-build source snapshots |                64 MiB combined |
| Paired-build ZIP artifacts    |                64 MiB combined |
| One renderer scene            |                      512 parts |
| One render view               |         32–256 pixels per axis |
| Contact sheet                 |                        720 KiB |

Payloads that can be safely shortened include explicit truncation metadata. Operations that cannot be completed within a safety bound fail without a partial write.

## Diagnostics and stdout

Under stdio transport, stdout is reserved for MCP JSON-RPC messages. Human diagnostics and logs are sent to stderr. Do not wrap the server with tooling that writes banners or status messages to stdout.
