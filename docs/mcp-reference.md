# MCP interface reference

Packwright exposes strict JSON Schema 2020-12 inputs and outputs. Successful calls include structured content and a short text fallback for clients that do not render structured results. Expected business failures—such as a stale hash, invalid datapack, or missing setup—are tool execution errors with structured details; malformed MCP requests are protocol errors.

Use MCP discovery from the connected client as the authoritative machine-readable schema. This document describes stable behavior without duplicating every schema field. The original nine datapack tools remain compatible; the paired visual compiler adds twelve tools.

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

## Paired visual tools

The v0.3 visual surface implements the custom-item vertical slice described in [Paired visual compiler](visual-compiler.md). Minecraft `support` is distinct from Packwright `compilerSupport`: `custom_item` reports `full`, `conditional_item_state` reports `limited`, and every other target reports `unsupported`. The state DSL exists, but broad property and built-in resolution are not exhaustive. Capability results for the other targets describe Minecraft's truthful representation boundary; they do not imply that a block, equipment, mob, display-rig, GUI, or mod compiler is present. Each paired project has exactly one active workflow head; v0.3 does not aggregate multiple independently active assets.

### `visual_capabilities`

Returns the Minecraft 26.2 resource-pack format and either one requested visual target or the complete capability matrix. Every entry includes `status` (`native`, `simulated`, `replacement`, or `requires_mod`), Minecraft `support`, Packwright `compilerSupport`, strategy names, `nativeIdentity`, and any required disclosure/limitation. `compilerSupport` is the field clients should use to decide whether the current server can compile a target. This operation is cache- and network-independent.

### `visual_project_attach`

Associates sibling datapack and resource-pack directories in `.packwright/projects/<id>.json`. It verifies the datapack, validates or creates a resource-pack `pack.mcmeta` using format `[88, 0]`, supports `dryRun`, and never moves an existing pack. A missing resource pack is created only when `createResourcepack` is true. Replacing a manifest requires `expectedManifestSha256`.

### `visual_asset_inspect`

Returns the paired manifest, the active head's logical item graph, optional asset-filtered nodes/edges, latest run, readiness for specification/textures/compile/render/binding/commit, and semantic diagnostics. `assetId` only filters that active graph; it does not select another project head or historical run. It never modifies a pack or draft.

### `visual_spec_upsert`

Validates a strict custom-item `ModelSpec` and creates a new immutable content-addressed run and initial revision. `reviewProfile` currently accepts only `held_item`. Optional `heldItem` metadata declares primary/secondary grips, muzzle or forward axis, handedness, item kind, two-handed intent, and use pose; this metadata controls profile scenes and advisory checks but is never serialized into Minecraft model JSON. The request includes creative intent and provider-neutral provenance. `parentRunId` and `expectedSpecSha256` guard updates relative to a previously inspected latest draft. This writes only private cache artifacts, never generated files into either pack.

### `texture_import`

Imports one named material texture into a run from canonical base64 or an exact workspace-relative PNG with its current SHA-256. Packwright verifies and bounds the PNG, decodes it safely, normalizes it to deterministic RGBA8 bytes, strips ancillary metadata from generated output, and creates a child revision that references the content-addressed texture. Arbitrary binary writing is not exposed.

### `visual_compile`

Compiles a selected immutable `ModelSpec` into exact 26.2 item-definition/model JSON, deterministic UV assignments, and required/generated texture drafts. Output remains in the run store. Compilation validates canonical serialization, texture readiness, geometry/UV constraints, graph relationships, and a fail-closed allow-list of supported 26.2 item properties and codec parameters. Any custom external texture or item-state model dependency must already exist at `assets/<namespace>/textures/<path>.png` or `assets/<namespace>/models/<path>.json` in the attached sibling resource pack. v0.3 does not search dependency packs, Mojang asset objects, the optional client-assets cache, or another filesystem location for it.

### `visual_connect`

Creates a guarded cross-pack proposal. The current binding strategy uses a caller-selected vanilla carrier and its `minecraft:item_model` component, and can add a generated `/give` helper plus an explicitly described shaped recipe. The proposal captures the expected SHA-256—or required absence—of every destination and returns its content-addressed `proposalSha256`. It does not alter the packs.

### `visual_render`

Runs the selected generic scene-review profile through the deterministic CPU renderer. The only implemented profile is `held_item@1`. Its 12 required views cover Steve/Alex first-person right and left arms, a wide-FOV first-person view, Steve/Alex third-person front/rear three-quarter views in both hands, and a neutral item-only comparison. Semantic metadata activates up to four additional required-for-that-draft scenes: swing midpoint, active use, two-handed grip, and aiming. `viewSize` is bounded to 32–256 pixels and a profile is bounded to 16 scenes.

The retained `includeContexts` field is a compatibility input for older callers; it cannot remove profile-required scenes. A `held_item@1` render therefore returns the same required scene plan whether that field is true or false.

The result reports `reviewProfile`, `profileVersion`, `reviewReady`, individual scene category/readiness data, and advisory measurement families for primary and secondary grip reach, approximate arm and torso intersection, alpha-weighted screen obscuration, forward-axis alignment, left/right pose symmetry, and projected-area frame retention. It returns the contact sheet as MCP image content, exposes individual views as image resources, and returns the URI of an immutable JSON report bound to the spec, compiled artifact, scene plan, renderer/profile versions, and view hashes. Missing `heldItem` metadata reports the semantic measurements it prevents as `skipped`; this preserves older visual specifications without claiming those checks passed. A configured failed measurement makes `reviewReady` false, while warnings and inapplicable skipped measurements do not. One-handed declarations retain every review image but exclude the undeclared hand from blocking measurements. The image and measurements remain available for repair.

### `visual_revision_create`

Creates an immutable child revision from an exact parent revision and `expectedSpecSha256`. Repairs are constrained to named part bounds/rotation/material, material values, one display transform, or explicit `held_item` metadata fields such as grip points, muzzle/axis, handedness, item kind, two-handed intent, and use pose. Free-form generated JSON replacement is not accepted. The instruction and targeted repairs become the immutable review record; the child must be recompiled and rerendered because its prior report is intentionally not inherited.

### `visual_commit`

Installs an explicitly accepted proposal into both packs. It requires `confirm: true`, the exact current `proposalSha256`, and a current `held_item@1` report for the same spec and compiled proposal with no failed advisory measurement. It verifies proposal content, report identity, required view hashes, and every captured destination precondition, then uses a sorted-lock, staged, journaled transaction. A stale or mismatched file prevents the transaction; no force option exists.

### `visual_validate`

Combines paired pack metadata; strict spec, texture, asset-graph, geometry/UV, profile-report readiness, and binding checks; vanilla-backed command validation; and optional GameTests. Render validation verifies the immutable report against the current spec hash, compiled artifact, profile plan, renderer/profile versions, required scenes, and view hashes. Advisory profile findings identify the review profile, scene, metric, semantic part when available, and a targeted repair. For a selected uncommitted proposal, Packwright verifies and reads its exact proposal bytes without committing them, reads stable full-pack snapshots, and applies those bytes as overlays: the resource-pack validator checks the entire sibling resource pack plus its overlay, while command validation and GameTests use the entire datapack plus its overlay. `includeVanilla` defaults to true and `includeGameTests` defaults to false. The result reports each layer as `passed`, `failed`, `skipped`, or `setup_required`.

The software renderer and agent review are not authoritative client-render evidence. Arm/torso intersection uses transformed axis-aligned bounding-box overlap rather than exact mesh collision, profile cameras/FOVs are representative, and conditional action scenes pose the base compiled geometry rather than resolving every selected conditional model. Actual-client resource reload/capture and block, armor, projectile, GUI-item, and entity-model review profiles are not implemented in this release.

### `project_build`

Accepts no run/revision selector and requires the project's one active workflow head to have ready textures and compiled artifacts and to be rendered, bound, and committed. It takes stable snapshots of the exact committed datapack and resource pack, validates those snapshots rather than a draft overlay (including mandatory vanilla command validation and full resource-pack validation), rechecks that neither source snapshot changed, and creates two independent deterministic artifacts: `<project>-data-26.2.zip` and `<project>-assets-26.2.zip` by default. Both ZIPs preserve their root `pack.mcmeta` and are installed together through one journaled transaction. The paired source snapshots and the paired ZIP payloads are each limited to 64 MiB combined.

With `overwrite: true`, callers must supply both `expectedDatapackSha256` and `expectedResourcepackSha256`. Each field accepts a SHA-256 when that output must already exist with those bytes, or `null` when that individual destination must be absent. Expected fields are rejected when `overwrite` is false. The result includes `truncated`; when true, its bounded diagnostic list was shortened.

## Tool annotations

The server advertises read-only, destructive, idempotent, and open-world hints for each tool. Treat annotations as client UX guidance, not authorization. The filesystem and hash checks enforce the actual safety boundary.

| Tool                     | Read-only | Destructive behavior                                                                          |
| ------------------------ | --------- | --------------------------------------------------------------------------------------------- |
| `datapack_create`        | No        | Creates a new directory only; never overwrites.                                               |
| `datapack_inspect`       | Yes       | None.                                                                                         |
| `resource_read`          | Yes       | None.                                                                                         |
| `resource_upsert`        | No        | Existing content changes only with overwrite intent and a current hash.                       |
| `resource_delete`        | No        | Exact-file deletion requires confirmation and a current hash.                                 |
| `datapack_validate`      | Yes       | None in the workspace.                                                                        |
| `minecraft_lookup`       | Yes       | None.                                                                                         |
| `datapack_test`          | Yes       | Uses disposable temporary state outside the pack.                                             |
| `datapack_build`         | No        | Creates or replaces only its declared build output.                                           |
| `visual_capabilities`    | Yes       | None.                                                                                         |
| `visual_project_attach`  | No        | Creates or hash-guards the project manifest and optional resource-pack metadata.              |
| `visual_asset_inspect`   | Yes       | None.                                                                                         |
| `visual_spec_upsert`     | No        | Creates immutable cache artifacts; never writes generated pack files.                         |
| `texture_import`         | No        | Creates a normalized, content-addressed cache artifact.                                       |
| `visual_compile`         | No        | Creates deterministic draft artifacts in the cache.                                           |
| `visual_connect`         | No        | Creates a hash-guarded proposal in the cache; does not apply it.                              |
| `visual_render`          | No        | Creates bounded preview artifacts in the cache.                                               |
| `visual_revision_create` | No        | Creates an immutable child revision; does not modify its parent.                              |
| `visual_commit`          | No        | Destructive hint: transactionally replaces only accepted, hash-matched proposal destinations. |
| `visual_validate`        | Yes       | None in the workspace; optional vanilla processes use disposable state.                       |
| `project_build`          | No        | Destructive hint: creates or hash-guards two declared ZIP outputs.                            |

## Resources

Resource URIs returned by MCP discovery provide read-only views of:

- The workspace pack list.
- Each pack's manifest, resource inventory, and last validation diagnostics.
- Supported Minecraft versions and their version-profile metadata.
- Locally cached Minecraft 26.2 registries and lookup readiness.
- The fixed Minecraft 26.2 visual capability matrix.

The visual compiler additionally exposes eight parameterized resource families:

- Paired project manifest.
- Project asset graph/readiness.
- Immutable draft `ModelSpec`.
- Generated contact sheet.
- Individual render view.
- Immutable profile render report with scene identities, measurements, thresholds, and artifact bindings.
- Latest targeted repair/review record.
- Declarative binding proposal.

The capability matrix is additionally available at its fixed URI listed above. Image resources use `image/png`; other visual resources use canonical JSON. The profile report is distinct from the latest targeted repair record. A missing render, report, repair record, or binding returns `not_found` rather than inventing an empty artifact.

Clients should use the URI returned by discovery rather than constructing URIs from this prose. Resource content may change after a write, validation, setup, or cache refresh; clients should re-read when freshness matters.

## Prompts

Five visual workflow prompts complement the three existing datapack prompts:

| Prompt                  | Purpose                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| `scaffold_feature`      | Plan the functions, tags, and supporting resources for a datapack feature before tool calls.   |
| `review_datapack`       | Inspect and validate a pack, then organize findings by severity and authority.                 |
| `author_gametest`       | Draft a vanilla-compatible GameTest workflow and surface missing structure/code prerequisites. |
| `generate_visual_asset` | Turn creative intent into an uncommitted semantic custom-item draft and preview.               |
| `review_visual_asset`   | Judge the profile report, contact sheet, and individual scenes without mutating files.         |
| `repair_visual_asset`   | Translate a profile finding into a targeted part/material/display/held-metadata revision.      |
| `connect_custom_item`   | Propose and validate a vanilla carrier plus `minecraft:item_model` binding.                    |
| `author_display_rig`    | Plan a truthful simulated display rig; automatic rig compilation is not implemented.           |

Prompts supply instructions and context only. Retrieving a prompt never writes a file or launches Minecraft.
