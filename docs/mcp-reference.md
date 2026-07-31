# MCP interface reference

Packwright exposes strict JSON Schema 2020-12 inputs and outputs. Successful calls include structured content and a short text fallback for clients that do not render structured results. Expected business failures—such as a stale hash, invalid datapack, or missing setup—are tool execution errors with structured details; malformed MCP requests are protocol errors.

Use MCP discovery from the connected client as the authoritative machine-readable schema. This document describes stable behavior without duplicating every schema field. The original nine datapack tools remain compatible; the paired visual compiler adds thirteen tools.

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

The visual surface implements the custom-item compiler vertical slice described in [Paired visual compiler](visual-compiler.md). Minecraft `support`, Packwright `compilerSupport`, and `clientCaptureSupport` are separate claims. The compiler still emits items only. Protocol-v3 client capture can additionally stage strict caller-declared block, headwear, existing-entity, and placeable representations without pretending Packwright compiled a new native identity. Each review-profile capability reports the accepted capture strategies and an actionable limitation/disclosure; unsupported strategies fail before Minecraft launches.

### `visual_capabilities`

Returns the Minecraft 26.2 resource-pack format and either one requested visual target or the complete capability matrix. Every entry includes `status` (`native`, `simulated`, `replacement`, or `requires_mod`), Minecraft `support`, Packwright `compilerSupport`, strategy names, `nativeIdentity`, and any required disclosure/limitation. Every review profile independently reports `clientCaptureSupport`, `clientCaptureTargetKind`, `clientCaptureStrategies`, and any capture limitation/disclosure. `compilerSupport` determines whether Packwright can compile a target; capture support determines whether the actual-client adapter can truthfully stage an exact declarative representation. This operation is cache- and network-independent.

### `visual_project_attach`

Associates sibling datapack and resource-pack directories in `.packwright/projects/<id>.json`. It verifies the datapack, validates or creates a resource-pack `pack.mcmeta` using format `[88, 0]`, supports `dryRun`, and never moves an existing pack. A missing resource pack is created only when `createResourcepack` is true. Replacing a manifest requires `expectedManifestSha256`.

### `visual_asset_inspect`

Returns the paired manifest, the active head's logical item graph, optional asset-filtered nodes/edges, latest run, readiness for specification/textures/compile/CPU render/client capture/binding/commit, and semantic diagnostics. Client-capture readiness is true only after the stored environment evidence re-verifies against the current revision. `assetId` only filters that active graph; it does not select another project head or historical run. Inspection never modifies a pack or draft.

### `visual_spec_upsert`

Validates a strict custom-item `ModelSpec` and creates a new immutable content-addressed run and initial revision. `reviewProfile` accepts `held_item`, `block`, `placeable`, `armor`, `head_wearable`, `projectile`, `gui_item`, or `entity_model`. The matching optional metadata field is `heldItem`, `blockReview`, `placeableReview`, `armorReview`, `headWearableReview`, `projectileReview`, `guiItemReview`, or `entityModelReview`; metadata for a different selected profile is rejected. Review metadata is never serialized into Minecraft JSON, so selecting a profile does not change compiler output or add support for that target. The request includes creative intent and provider-neutral provenance. `parentRunId` and `expectedSpecSha256` guard updates relative to a previously inspected latest draft. This writes only private cache artifacts, never generated files into either pack.

### `texture_import`

Imports one named material texture into a run from canonical base64 or an exact workspace-relative PNG with its current SHA-256. Packwright verifies and bounds the PNG, decodes it safely, normalizes it to deterministic RGBA8 bytes, strips ancillary metadata from generated output, and creates a child revision that references the content-addressed texture. Arbitrary binary writing is not exposed.

### `visual_compile`

Compiles a selected immutable `ModelSpec` into exact 26.2 item-definition/model JSON, deterministic UV assignments, and required/generated texture drafts. Output remains in the run store. Compilation validates canonical serialization, texture readiness, geometry/UV constraints, graph relationships, and a fail-closed allow-list of supported 26.2 item properties and codec parameters. Any custom external texture or item-state model dependency must already exist at `assets/<namespace>/textures/<path>.png` or `assets/<namespace>/models/<path>.json` in the attached sibling resource pack. v0.4 does not search dependency packs, Mojang asset objects, the client cache, or another filesystem location for it.

### `visual_connect`

Creates a guarded cross-pack proposal. The current binding strategy uses a caller-selected vanilla carrier and its `minecraft:item_model` component, and can add a generated `/give` helper plus an explicitly described shaped recipe. The proposal captures the expected SHA-256—or required absence—of every destination and returns its content-addressed `proposalSha256`. It does not alter the packs.

### `visual_render`

Runs the selected model-specific scene-review profile through the deterministic CPU renderer. The eight version-1 profiles use these specialized scene families:

| Profile         | Deterministic review scenes                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `held_item`     | Steve/Alex first- and third-person hands, wide FOV, neutral item, and declared swing/use/two-hand/aim poses            |
| `block`         | Inventory presentation, placed-world view, six sides, adjacent-block context, and representative lighting/culling cues |
| `placeable`     | Declared orientations, floor/wall/ceiling attachments, a neutral comparison, and collision-footprint context           |
| `armor`         | Steve/Alex bodies, declared armor slots, front/rear/side views, and representative walking/crouching poses             |
| `head_wearable` | Steve/Alex head views, first-person obstruction, and armor-stand presentation                                          |
| `projectile`    | In-hand, in-flight angles, impact/stuck orientation, and declared forward-axis context                                 |
| `gui_item`      | Inventory and hotbar sizes plus declared count, durability, glint, and tooltip presentation cues                       |
| `entity_model`  | Turntable, declared pose snapshots, player-scale comparison, and hitbox-overlay views                                  |

Packwright-authored arms, bodies, heads, adjacent blocks, attachment planes, footprint/hitbox guides, GUI frames, and armor stands are reference geometry only; they never enter compiled pack output. `viewSize` is bounded to 32–256 pixels, and every resolved profile plan is bounded to 16 scenes.

The retained `includeContexts` field is a compatibility input for older callers; it cannot remove profile-required scenes. A render therefore returns the same profile-required plan whether that field is true or false.

The result reports `reviewProfile`, `profileVersion`, `reviewReady`, individual scene category/readiness data, and the selected profile's advisory measurements. Those include common frame retention plus applicable grip/intersection, placement/attachment, icon occupancy, forward-orientation, reference-scale, obstruction, or hitbox-containment checks. It returns the contact sheet as MCP image content, exposes individual views as image resources, and returns the URI of an immutable JSON report bound to the spec, compiled artifact, scene plan, renderer/profile versions, and view hashes. Missing optional semantic metadata reports the measurements it prevents as `skipped`; this preserves older visual specifications without claiming those checks passed. A configured failed measurement makes `reviewReady` false, while warnings and inapplicable skipped measurements do not. The image and measurements remain available for repair.

### `visual_capture`

Launches the pinned official Minecraft 26.2 client to capture the exact current uncommitted proposal and representation through Minecraft's screenshot API. It requires the exact `projectId`, run/revision, current `proposalSha256`, `confirm: true`, Java 25, prior operator-run `setup-version 26.2 --accept-minecraft-eula --client-capture`, and an interactive macOS graphical session. Resolution is bounded to 640×360–1920×1080, GUI scale to 0–8, and timeout to 30–600 seconds. `includeScaleReferenceViews` and `includeDebugHitboxViews` default to `false`.

Packwright snapshots both packs, applies the proposal, creates deterministic staging ZIPs, and launches a fresh disposable neutral studio in offline developer mode with multiplayer and chat disabled. Only the bundled Packwright capture mod is installed. The optional `representation` is a strict tagged union: `native_block_state`, `block_display`, `equippable_head`, `native_entity`, `display_rig`, `native_placeable_block`, or `native_placeable_entity`. Omission derives the connected `item_stack` representation only for item profiles; protocol v3 requires that item representation to contain exactly one canonical proposal-bound rendered state. Display rigs contain ordered allow-listed item/block display nodes, transforms, render properties, and a bounded interaction. Protocol v3 accepts only static display nodes, rejects block animated-texture tick requests because Minecraft exposes no authoritative resettable atlas phase, and requires simulated entity rigs to bind separate exact `idle`, `walk`, and `attack` states. Headwear binds the exact `minecraft:equippable` component: equipment-model mode requires `asset_id`, fallback mode forbids it, `camera_overlay` must match the declaration, and optional chest compatibility binds a complete chest item stack. `displaySettlingTicks` is accepted only for `display_rig` and `block_display`, defaults to two, and is capped at 40. No representation accepts a command, function, save, path, credential, executable, arbitrary NBT, or extra mod.

The capture mod waits for resource reload/model baking, creates the strict fixture, waits at least two client ticks (or the bounded display interval), configures the deterministic studio/camera/state, and writes framebuffer PNGs through Minecraft's screenshot API. Required scenes never contain Packwright debug UI or injected comparisons. `first_person_scale_reference`, `debug_hitbox_reference`, bare-head and same-frame injected `comparison_reference`, non-ordinary `world_scale_reference`, and empty-subject `measurement_control` frames are always `augmented_qa_reference`, live only in the generic supplemental sheet, and can never replace a required frame. A measurement control is camera/environment-paired to one authoritative frame and may calibrate advisory client-pixel masks, but it never makes a capture authoritative or unready. Ordinary in-world block geometry remains authoritative exact Minecraft evidence when declared; an armor stand is authoritative only when it is the actual declared headwear subject. Injected player/mannequin scale aids remain supplemental.

Packwright verifies the atomic completion sentinel, canonical report, complete required/supplemental partition, full bounded log, PNG dimensions/hashes, and all plan/proposal/runtime identities before storing immutable evidence. Protocol v3 binds the full tagged representation and its SHA-256; exact staged pack snapshots; Minecraft/capture-mod; OS, Java, GPU/driver and OpenGL backend; resolution, GUI scale, FOV, render/simulation distance and graphics settings; camera pose, biome, time, weather, the configured light source and observed subject light, tick/animation state; fixture evidence and actual settling ticks; plus every source framebuffer hash. Each view also carries a separately hashed canonical `observedFixture`, populated only after client-world readback verifies exact block state, item/equipment stack, entity type/variant/age/equipment, or ordered display nodes and interaction dimensions. Every returned view repeats `targetKind` and `representationSha256`.

The result-level `authority` remains `authoritative_environment_capture` with `authorityScope: "required_views_only"`. `requiredViewIds` and `supplementalViewIds` form a complete disjoint partition. The schema rejects relabeled debug/scale/comparison views, mismatched target/representation hashes, missing views, and supplemental sheets that do not exactly match supplemental evidence. `contactSheetUri` contains required gameplay/world frames only; `supplementalContactSheetUri` contains augmented QA. The deprecated scale-only URI reads legacy protocol-v2 evidence but is not v3's canonical field.

Actual-client `measurements` are derived from the bound framebuffer pixels and carry `authority: "client_pixels"`, contributing scene IDs, source PNG hashes, and an explicit `requiredForReadiness` bit copied from the hash-bound plan. Results distinguish `passed`, `warning`, `failed`, and `skipped`; a skipped metric has an explicit reason and cannot masquerade as a measured pass. Only calibrated two-frame metrics whose sources are both required authoritative scenes may set `requiredForReadiness: true`. A failed **or skipped** readiness-critical measurement makes `captureReady` false, returns capture status `failed`, and blocks commit; a critical warning remains visible without blocking. Geometry proxies without calibrated segmentation remain best-effort and explicitly skipped. Measurements that consume a supplemental measurement-control/debug frame are always noncritical, even when attached to a required scene, and supplemental-only failures remain QA findings. A passed capture proves evidence completeness and absence of failed or unavailable readiness-critical measurements, not aesthetic approval.

Client capture is `full` for `gui_item`; `limited` for one-handed `held_item`, `block`, `head_wearable`, `entity_model`, and `placeable`; and unsupported for `armor` and `projectile`. Native block-state capture is an appearance binding on an existing vanilla block; `block_display` is simulated. Transparent blocks receive distinct light-backdrop, dark-backdrop, and overlapping-copy frames. Headwear requires an actually equipped `minecraft:equippable` head item and discloses item fallback versus equipment-model layer and camera overlay. Native entity core idle/walk/attack authority currently requires a `default` zombie because its attack state is renderer-observable; other allow-listed entities appear only as explicit bounded idle matrix states. Variant-capable cats, chickens, cows, frogs, pigs, and wolves require a resolved registry variant rather than an unspecified default. Display rigs remain simulated. Native placeable block/entity strategies are floor-only; a native block must bind a matching `facing` state for every cardinal view. Wall and ceiling attachments require the simulated display-rig strategy with exact attachment origins. Required stock frames are authoritative only for their recorded environment and representation—not pixel-deterministic across hardware or proof of a new native identity.

### `visual_revision_create`

Creates an immutable child revision from an exact parent revision and `expectedSpecSha256`. Repairs are constrained to named part bounds/rotation/material, material values, one display transform, or explicit `held_item` metadata fields such as grip points, muzzle/axis, handedness, item kind, two-handed intent, and use pose. Free-form generated JSON replacement is not accepted. The instruction and targeted repairs become the immutable review record; the child must be recompiled and rerendered because its prior report is intentionally not inherited.

### `visual_commit`

Installs an explicitly accepted proposal into both packs. It requires `confirm: true`, the exact current `proposalSha256`, and a current CPU report from the selected review profile for the same spec and compiled proposal with no failed advisory measurement. In production application instances, a profile with full or limited client-capture support additionally requires `expectedClientCaptureReportSha256` equal to the exact current verified report with no failed required client-pixel measurement. The evidence must also report `proposalBindingStatus: "implemented"`. Protocol-v3 block, headwear, entity, and placeable captures currently report `capture_only`: they validate the exact representation as QA evidence but cannot authorize the current item-compiler proposal until that compiler implements the same representation. Omitting evidence, supplying capture-only, stale, or measurement-failed evidence, or supplying a different digest fails the precondition; a supported proposal cannot use advisory validation to bypass commit authority. Capture-unsupported profiles remain CPU-only.

Commit independently re-renders the immutable spec and verified texture inputs, recomputes canonical measurements, compares proposal content, CPU report identity, scene/contact-sheet hashes, client evidence when required, and every captured destination precondition, then uses a sorted-lock, staged, journaled transaction. Its durable receipt binds accepted capture evidence, source report, plan, runtime manifest, client/mod, staged pack, manifest, proposal, and output hashes. Editing cached report statuses or references cannot make a failed/stale review committable. A stale or mismatched file prevents the transaction; no force option exists. The result repeats `clientCaptureReportSha256` when client evidence was accepted.

### `visual_validate`

Combines paired pack metadata; strict spec, texture, asset-graph, geometry/UV, profile-report readiness, existing client-capture evidence, and binding checks; vanilla-backed command validation; and optional GameTests. Render validation independently reconstructs the CPU render and measurements, then verifies its immutable report against the current spec hash, compiled artifact, profile plan, renderer/profile versions, required scenes, view hashes, and canonical evidence. Advisory profile findings identify the review profile, scene, metric, semantic part when available, and a targeted repair. For a selected uncommitted proposal, Packwright verifies and reads its exact proposal bytes without committing them, reads stable full-pack snapshots, and applies those bytes as overlays: the resource-pack validator checks the entire sibling resource pack plus its overlay, while command validation and GameTests use the entire datapack plus its overlay.

`includeVanilla` defaults to true and `includeGameTests` defaults to false. `requireClientCapture` is tri-state: when omitted, capture is required for every profile whose official-client support is `full` or `limited` and skipped for `unsupported`; `false` explicitly selects advisory/fast validation; `true` requires capture and therefore fails a capture-unsupported profile rather than pretending it passed. Validation only verifies stored evidence and never launches the graphical client. Missing required setup/evidence reports `setup_required`; invalid or unsupported required evidence reports `failed`.

The software renderer and agent review are not authoritative client-render evidence. Transformed axis-aligned bounds are approximations, profile cameras/FOVs are representative, and conditional/action scenes pose the base compiled geometry rather than running Minecraft's gameplay or animation systems. Lighting, culling, collision, attachment, glint, durability, tooltip, equipment fit, projectile motion, entity animation, and hitbox scenes are deterministic review cues—not proof of their real-client behavior. Official-client capture supplies a separate environment-scoped authority and does not make the CPU report authoritative.

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
| `visual_capture`         | No        | Requires confirmation; launches a disposable client and creates hash-bound cache evidence.    |
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

The visual compiler additionally exposes twelve parameterized resource families:

- Paired project manifest.
- Project asset graph/readiness.
- Immutable draft `ModelSpec`.
- Generated contact sheet.
- Individual render view.
- Immutable profile render report with scene identities, measurements, thresholds, and artifact bindings.
- Latest targeted repair/review record.
- Declarative binding proposal.
- Verified official-client capture report and provenance.
- Authoritative official-client gameplay/world contact sheet, excluding every augmented view.
- Optional generic supplemental QA contact sheet for scale-reference and debug-hitbox views; it is never WYSIWYG or authoritative.
- Individual bounded deterministic client preview with its source framebuffer PNG hash retained in the report and its `viewKind`/authority recorded by the capture result and report.

The capability matrix is additionally available at its fixed URI listed above. Image resources use `image/png`; other visual resources use canonical JSON. CPU, authoritative client, and augmented supplemental contact sheets/views use distinct URI families and authority labels. The deprecated scale-only resource can read legacy protocol-v2 evidence; v3 uses the generic supplemental resource. The profile report is distinct from the client-capture report and latest targeted repair record. A missing render, capture, report, repair record, or binding returns `not_found` rather than inventing an empty artifact.

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
