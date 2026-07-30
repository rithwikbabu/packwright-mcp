# MCP interface reference

Packwright exposes strict JSON Schema 2020-12 inputs and outputs. Successful calls include structured content and a short text fallback for clients that do not render structured results. Expected business failures—such as a stale hash, invalid datapack, or missing setup—are tool execution errors with structured details; malformed MCP requests are protocol errors.

Use MCP discovery from the connected client as the authoritative machine-readable schema. This document describes stable v1 behavior without duplicating every schema field.

## Tools

### `datapack_create`

Creates a new Minecraft 26.2 pack below the workspace. The request provides the pack path, namespace, description, and optional load or tick functions. The generated `pack.mcmeta` uses `min_format` and `max_format` set to `[107, 1]`.

The target must not already exist. `dryRun` returns the planned files and diffs without creating anything.

### `datapack_inspect`

Returns pack metadata, discovered namespaces, resource inventory, file hashes, 26.2 compatibility, limits encountered, and validation/setup readiness. It does not modify the pack.

### `resource_read`

Reads a resource by its resource type and namespaced identifier, or reads an allowed datapack text file by a pack-relative path. The result includes content, SHA-256, media/type information, and explicit truncation metadata when the MCP payload limit applies.

### `resource_upsert`

Creates or updates a common typed datapack resource or guarded raw text file. New files do not require an overwrite flag. Replacing an existing file requires both `overwrite: true` and `expectedSha256` matching its current bytes.

Writes are size-limited, serialized per target path, staged to a same-directory temporary file, and committed by atomic rename. `dryRun` returns a diff and resulting hash without writing.

Model-authored raw content is limited to JSON, MCFunction, MCMETA, and SNBT datapack text. Packwright does not author binary NBT or PNG files.

### `resource_delete`

Deletes exactly one resource or allowed text file. It requires `confirm: true` and a matching `expectedSha256`. Directories and recursive deletion are never accepted.

### `datapack_validate`

Runs Packwright's owned structural checks and vanilla-backed command validation by default. The vanilla adapter compiles every logical `.mcfunction` command with Minecraft 26.2's real dispatcher, the pack-aware registries loaded by that runtime, and its component codecs. This detects invalid commands, items/components, text components, selectors, particles, attributes, entity data, and other Brigadier/codec inputs before packaging. When the operator has explicitly configured `PACKWRIGHT_SPYGLASS_COMMAND`, the complementary external Spyglass adapter also runs.

Results include normalized diagnostics with engine, authority, severity, stable code, original file/range, message, and an optional suggested fix, plus a vanilla summary with status, files and logical command lines checked, deferred macro count, and duration. Minecraft's rejection is authoritative; identifier suggestions are deterministic heuristics over the verified cached 26.2 reports. Text fallbacks render the original physical line in a form such as `spell/chain/cast.mcfunction:12`, followed by the message and suggestion.

`includeVanilla` defaults to `true` and requires Java 25 plus prior operator-run setup. Missing setup returns `setup_required`. Passing `includeVanilla: false` is an explicit validation-only escape hatch that leaves structural checks—and configured Spyglass diagnostics—available without the jar. Structural MCFunction/SNBT text checks cover supported extensions, UTF-8, NUL bytes, and basic SNBT delimiter/string termination, not full command or SNBT semantics.

Command validation never executes the pack's functions: Packwright replaces staged function bodies with inert placeholders and lets vanilla compile unreferenced per-command probes in a disposable harness. Function macros are template-checked, but commands after `$` substitution remain runtime-dependent and are reported as deferred. The parser also cannot prove that objectives, entities, storage, scheduled state, or other world conditions exist. See [Validation and vanilla testing](validation-and-testing.md).

### `minecraft_lookup`

Searches locally cached Minecraft 26.2 commands, registries, resource types, and identifiers. It never performs a network request. If the trusted cache has not been prepared, `cacheReady` is false and only Packwright's built-in resource-type matches are available.

### `datapack_test`

Stages the pack and runs selected GameTests through the official vanilla entrypoint in a new disposable universe. Test selectors identify exact `test_instance` resources, not datapack functions. The default five-minute timeout is one shared budget for mandatory command prevalidation and the GameTest run. Cancellation and timeout terminate the subprocess and clean up temporary state.

The result reports setup status, selected tests, normalized cases, bounded log excerpts, diagnostics, exit status, and elapsed time. Java 25 and prior operator-run setup are required.

In vanilla, a function-type test references the internal `test_function` registry, not a datapack `.mcfunction`. Packwright rejects custom-namespace Test Function IDs and guides behavior-focused tests toward existing `block_based` structures.

### `datapack_build`

Runs structural checks and mandatory vanilla-backed command validation, then creates a deterministic ZIP with `pack.mcmeta` at the archive root. There is no build input that disables vanilla validation: missing Java 25/cache setup, a structural error, or any authoritative command parse error blocks the build. The result includes output path, byte size, SHA-256, validation diagnostics, and the vanilla validation summary.

## Tool annotations

The server advertises read-only, destructive, idempotent, and open-world hints for each tool. Treat annotations as client UX guidance, not authorization. The filesystem and hash checks enforce the actual safety boundary.

| Tool                | Read-only | Destructive behavior                                                    |
| ------------------- | --------- | ----------------------------------------------------------------------- |
| `datapack_create`   | No        | Creates a new directory only; never overwrites.                         |
| `datapack_inspect`  | Yes       | None.                                                                   |
| `resource_read`     | Yes       | None.                                                                   |
| `resource_upsert`   | No        | Existing content changes only with overwrite intent and a current hash. |
| `resource_delete`   | No        | Exact-file deletion requires confirmation and a current hash.           |
| `datapack_validate` | Yes       | None in the workspace.                                                  |
| `minecraft_lookup`  | Yes       | None.                                                                   |
| `datapack_test`     | Yes       | Uses disposable temporary state outside the pack.                       |
| `datapack_build`    | No        | Creates or replaces only its declared build output.                     |

## Resources

Resource URIs returned by MCP discovery provide read-only views of:

- The workspace pack list.
- Each pack's manifest, resource inventory, and last validation diagnostics.
- Supported Minecraft versions and their version-profile metadata.
- Locally cached Minecraft 26.2 registries and lookup readiness.

Clients should use the URI returned by discovery rather than constructing URIs from this prose. Resource content may change after a write, validation, setup, or cache refresh; clients should re-read when freshness matters.

## Prompts

| Prompt             | Purpose                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `scaffold_feature` | Plan the functions, tags, and supporting resources for a datapack feature before tool calls.   |
| `review_datapack`  | Inspect and validate a pack, then organize findings by severity and authority.                 |
| `author_gametest`  | Draft a vanilla-compatible GameTest workflow and surface missing structure/code prerequisites. |

Prompts supply instructions and context only. Retrieving a prompt never writes a file or launches Minecraft.
