# Paired visual compiler

Packwright can associate a Minecraft Java Edition 26.2 datapack with a sibling resource pack and turn a semantic custom-item description into reviewable, deterministic files. The supported workflow is:

```text
describe -> generate draft -> connect behavior -> render -> visually review
         -> targeted repair -> validate -> explicit commit -> build both packs
```

Draft operations write only to Packwright's local cache. They do not overwrite either pack. `visual_commit` is the single operation that installs an accepted proposal into both workspace packs, and `project_build` creates two separate ZIP artifacts.

## Current scope

Packwright v0.3.0 implements the custom-item vertical slice:

- Paired project manifests for an existing 26.2 datapack and a sibling resource pack using format `88.0`.
- A strict semantic `ModelSpec` for item cuboids, planes, named materials, deterministic UVs, supported element rotations, item-state trees, and display transforms.
- Compilation to `assets/<namespace>/items/<path>.json`, `assets/<namespace>/models/item/<path>.json`, and PNG textures.
- A `minecraft:item_model` binding to a caller-selected vanilla carrier item, with an optional `/give` helper and shaped recipe.
- An asset graph spanning the logical item, carrier, component, client item definition, model, and textures.
- A deterministic CPU preview renderer, immutable repair revisions, guarded multi-file commit, layered validation, and deterministic paired builds.

The capability matrix separates what Minecraft 26.2 can represent (`status` and `support`) from what Packwright v0.3 can compile (`compilerSupport`). `compilerSupport` is `full` for `custom_item`, `limited` for `conditional_item_state`, and `unsupported` for every other target. The item-state DSL exists, but its property coverage and built-in resolution are not exhaustive. Block models, equipment, paintings and trims, mob variants, display rigs, keyframe animation, GUI/font/sprite authoring, generator subprocess adapters, multi-asset project heads, and real-client screenshot capture remain later phases. `author_display_rig` produces a truthful plan; it does not generate commit-ready rig files.

The 26.2 client profile uses resource-pack format `88.0` and treats beds, standing signs, and hanging signs as block-model paths rather than the removed special-model types. Special models that the CPU renderer cannot reproduce are marked unsupported with client-capture-required fallbacks.

Packwright has no built-in remote generation provider and requires no OpenAI key. The default path is agent-driven: the MCP client supplies the creative intent and `ModelSpec`, and may supply PNGs using its own image-generation capability. Packwright performs deterministic compilation, rendering, validation, connection, artifact storage, and commit.

## Capability boundary

Every target is labeled with one of four statuses:

- `native` means vanilla exposes the relevant data-driven representation. It does not necessarily mean a new registry identity; inspect `nativeIdentity` and the disclosure.
- `simulated` means the result uses a vanilla carrier, display entities, or datapack behavior. It is not a native new block, entity, projectile, or particle.
- `replacement` means an existing vanilla identity or appearance is replaced or selected.
- `requires_mod` means vanilla cannot represent the requested result faithfully.

The Minecraft 26.2 profile reports:

| Target                            | Status         | Minecraft boundary                                                           | `compilerSupport` |
| --------------------------------- | -------------- | ---------------------------------------------------------------------------- | ----------------- |
| Custom item                       | `native`       | Vanilla base item plus `minecraft:item_model`; no new item registry identity | `full`            |
| Conditional item state            | `native`       | `condition`, `select`, `range_dispatch`, and composite item models           | `limited`         |
| Existing block appearance         | `replacement`  | Blockstate/block-model replacement or selection                              | `unsupported`     |
| New block identity                | `simulated`    | Carrier block state or block-display rig                                     | `unsupported`     |
| Furniture/static prop             | `simulated`    | Item/block displays with optional interaction entity                         | `unsupported`     |
| Armor/equipment                   | `native`       | Only equipment assets and slots exposed by 26.2                              | `unsupported`     |
| Painting/trim/data-driven variant | `native`       | Datapack registry entry plus resource-pack asset                             | `unsupported`     |
| Existing mob texture              | `replacement`  | Available data-driven variant or vanilla texture replacement                 | `unsupported`     |
| Existing mob geometry             | `requires_mod` | No general vanilla resource-pack geometry mechanism                          | `unsupported`     |
| New mob/pet                       | `simulated`    | Invisible vanilla carrier plus display rig and behavior                      | `unsupported`     |
| Skeletal animated creature        | `simulated`    | Display hierarchy and datapack keyframes, with performance limits            | `unsupported`     |
| Projectile/spell visual           | `simulated`    | Existing projectile or display carrier and existing particles                | `unsupported`     |
| New particle type                 | `requires_mod` | Existing particles/display approximation only; a real new type needs a mod   | `unsupported`     |
| GUI/font/sprite                   | `native`       | Resource-pack image/font/atlas assets                                        | `unsupported`     |

Call `visual_capabilities` before designing an asset. A client should surface the returned `status`, Minecraft `support`, Packwright `compilerSupport`, `nativeIdentity`, `disclosure`, and `limitation` rather than inferring either vanilla or compiler support from the target name.

## Paired projects

Pack roots remain where they already are:

```text
workspace/
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

The manifest is strict and versioned:

```json
{
  "schemaVersion": 1,
  "id": "firestaff",
  "minecraftVersion": "26.2",
  "datapack": "firestaff-data",
  "resourcepack": "firestaff-assets",
  "target": "vanilla"
}
```

The two pack paths must be confined, sibling directories beneath the workspace. `visual_project_attach` can create a missing resource-pack directory with a format-`88.0` `pack.mcmeta`, or associate an existing compatible pack. It supports `dryRun`; replacing an existing project manifest requires its current hash.

v0.3 keeps exactly one active workflow head for each paired project, not one head per asset or run. Creating or repairing a draft advances that head; inspection and operations with omitted run/revision IDs select it, and `project_build` always uses it. `assetId` only filters the active graph returned by inspection; it does not select a historical asset head. Immutable older runs remain content-addressed and addressable by operations or resources that accept exact IDs, but v0.3 does not aggregate several independently active item heads into one project graph.

## Semantic `ModelSpec`

Agents should author this constrained representation instead of arbitrary Minecraft model JSON. Semantic IDs make review and repair local: a reviewer can ask to shorten `handle`, resize `crystal`, recolor material `fire`, or adjust `firstperson_righthand` without regenerating the entire asset.

```json
{
  "schemaVersion": 1,
  "id": "arcana:firestaff",
  "targetKind": "item",
  "template": "handheld_3d",
  "textureSize": [32, 32],
  "materials": {
    "wood": {
      "color": "#4b2c1b",
      "emissive": false,
      "transparent": false
    },
    "fire": {
      "color": "#ff6a18",
      "emissive": true,
      "transparent": false
    }
  },
  "parts": [
    {
      "id": "handle",
      "shape": "cuboid",
      "from": [7, 0, 7],
      "to": [9, 13, 9],
      "material": "wood",
      "uvMode": "box",
      "shade": true
    },
    {
      "id": "crystal",
      "shape": "cuboid",
      "from": [6, 12, 6],
      "to": [10, 16, 10],
      "material": "fire",
      "parent": "handle",
      "uvMode": "box",
      "shade": true
    }
  ],
  "displayPreset": "handheld_3d",
  "display": {},
  "states": [],
  "connection": {
    "strategy": "minecraft:item_model",
    "carrierItem": "minecraft:stick"
  }
}
```

The current schema supports cuboids and single-axis planes; named parent relationships; element rotations on `x`, `y`, or `z` at Minecraft-supported angles; automatic box UVs or explicit face UVs; colors, external textures, tint indices, transparency, and emissive intent; all standard item display contexts; and condition/select/range/composite item states. Semantic parents name review groups only: each part retains model-space coordinates and its own Minecraft element rotation rather than inheriting an animation transform. Item properties and their codec fields are validated against an explicit 26.2 allow-list; an unknown property, unexpected parameter, or invalid enumerated select value is rejected instead of being copied into client JSON. Emissive intent is recorded but the vanilla item model compiler does not claim true emissive rendering. A custom external texture or item-state model must already exist at `assets/<namespace>/textures/<path>.png` or `assets/<namespace>/models/<path>.json` in the project's sibling resource pack. Packwright does not search dependency packs, Mojang asset objects, the client-assets cache, or another filesystem location to resolve it.

## Exact workflow

1. Call `visual_capabilities` and state the requested target's truthful capability status.
2. Call `visual_project_attach` to associate the existing datapack with a sibling resource pack. Use `dryRun` first when creating either the resource-pack metadata or project manifest.
3. Convert the request into a strict `ModelSpec`, then call `visual_spec_upsert`. Record provider, model/version, prompt, seed when available, and reference hashes in provenance.
4. Call `texture_import` for each supplied material PNG. A missing generated texture is filled deterministically from the material color, or a stable hash-derived fallback when no color is declared.
5. Call `visual_compile`. This writes canonical draft files to the content-addressed run store, not the workspace packs.
6. Call `visual_connect` with a safe vanilla carrier. Review the proposed resource-pack files, `minecraft:item_model` component, helper function, optional recipe, captured destination hashes, and returned `proposalSha256`.
7. Call `visual_render`. Review the returned contact-sheet image, then read individual image resources for ambiguous views.
8. If review finds a defect, call `visual_revision_create` with the parent revision ID, its exact `expectedSpecSha256`, a human-readable finding, and only the named part/material/display repairs. Compile and render the child revision, then review it again.
9. Call `visual_validate`. It validates the exact current uncommitted proposal as an overlay on stable snapshots of the full sibling packs: resource-pack checks see the complete resource-pack snapshot plus proposed files, while vanilla command validation and optional GameTests see the complete datapack snapshot plus its proposal files. Keep vanilla command validation enabled for release evidence; enable GameTests when the datapack has relevant tests.
10. After explicit acceptance, call `visual_commit` with `confirm: true` and the exact current `proposalSha256`.
11. Call `project_build` to revalidate the exact committed datapack and resource-pack snapshots and transactionally install their independent deterministic ZIPs.

Neither the generation, review, nor repair prompts mutate files. An agent must not treat a rendered image as authorization to commit.

## Immutable runs and revisions

Runs live under `<cache>/visual-runs/<run-id>/`. The run ID is derived from canonical request, specification, and provenance hashes. Each repair creates a content-addressed child under `revisions/<revision-id>/`; existing run and revision directories are never edited in place. Textures, compiled proposals, renders, and reviews are stored by content hash, while `<cache>/visual-project-state/` indexes the one active head for each project.

The run store bounds canonical JSON to 4 MiB, compiled artifacts to 2,048 files or 64 MiB, and stored PNG reads to 8 MiB. The accepted workspace output remains deterministic even if an external client used nondeterministic image generation before import.

## PNG safety

`texture_import` accepts either canonical base64 within the one-MiB MCP request budget or an exact workspace-relative file with its current SHA-256. Workspace sources must be regular, non-symlink files within the configured root.

The decoder verifies the PNG signature, chunk boundaries/order/count, CRCs, image mode, dimensions, palette/transparency rules, and bounded decompression. It accepts supported 8-bit, non-interlaced PNG color types and rejects unknown critical chunks, malformed compressed data, trailing bytes, and decompression bombs. Default limits are:

| PNG limit         |        Value |
| ----------------- | -----------: |
| Encoded file      |        8 MiB |
| Width or height   | 4,096 pixels |
| Total pixels      |   16,777,216 |
| Decoded RGBA data |       64 MiB |
| Chunks            |        4,096 |

Imported images are normalized to deterministic RGBA8 PNG bytes; ancillary metadata is not carried into generated project output.

## Deterministic renderer

`visual_render` uses the CPU-only `packwright-cpu-v1` renderer. It consumes the compiler's canonical sorted geometry, exact UV layout, element rotations/rescale behavior, tint intent, and shared display-transform resolution; tessellates cuboids and planes; projects with fixed cameras; z-buffers opaque surfaces; alpha-blends transparency; samples textures with nearest-neighbor filtering; and applies fixed approximate GUI lighting. It does not launch Chromium, Blender, native OpenGL, or Minecraft.

The standard set contains eight turntable views plus inventory 64×64, inventory 32×32, ground, fixed/item-frame, first-person right, first-person left, and third-person hand contexts. Individual views are exposed as PNG resources. The contact sheet is at most 720 KiB and is returned as MCP image content; render size is 32–256 pixels, scenes are capped at 512 parts, and raster work is bounded.

The renderer is a fast deterministic review aid, not proof of exact client rendering. Special models marked unsupported by the profile require later real-client capture. The current release has no actual-client screenshot harness.

## Transactional commit and build

`visual_connect` records the SHA-256 or expected absence of every destination. `visual_commit` then:

1. Resolves every destination beneath the correct paired pack.
2. Acquires locks in sorted path order.
3. Verifies all proposal content and destination preconditions before changing a file.
4. Stages output beside each destination and records a journal under `.packwright/transactions/`.
5. Installs the files with atomic filesystem operations.
6. Attempts rollback if installation fails and retains the journal when manual recovery is required.

A visual transaction is limited to 512 files and 64 MiB. There is no force flag for stale hashes. `project_build` accepts no run/revision selector and requires the project's active revision to have ready textures and compiled artifacts and to be rendered, bound, and committed. It validates the exact current committed snapshots of both packs, not a draft overlay, rechecks that both source snapshots remain unchanged, and emits `<project>-data-26.2.zip` and `<project>-assets-26.2.zip` by default. Both archives are installed through one journaled transaction. The paired source snapshots and paired ZIP payloads are independently limited to 64 MiB combined, so an oversized pair fails before Packwright materializes or installs unusable output. With `overwrite: true`, both `expectedDatapackSha256` and `expectedResourcepackSha256` must be present; each is either the destination's current SHA-256 or `null` when that destination is expected not to exist. The result's `truncated` flag reports whether bounded diagnostics were shortened.

## Validation evidence

`visual_validate` reports these layers independently: paired metadata, schema, texture, asset graph, geometry/UV, render readiness, binding, vanilla commands, and GameTests. It applies the exact uncommitted proposal to stable full-pack snapshots before resource-pack, command, and GameTest checks, so validation evidence covers the bytes proposed for commit rather than only the already committed packs. Semantic diagnostics name an asset and, where possible, its exact part, material, or display context.

The current automated visual checks cover strict schema/canonical compilation, required textures, zero-area UV assignments, material/tint conflicts, part relationships, approximate display clipping, graph endpoints/cycles/orphans, and the `minecraft:item_model` chain. Agent visual review supplies aesthetic judgment; it is not an authoritative Minecraft result. Vanilla-backed command validation remains authoritative for datapack command syntax, while an optional GameTest supplies behavior evidence.

Client-asset setup is optional for the current semantic compiler, software renderer, and validator. In v0.3 it is a setup/readiness signal only, not a built-in resolver for model parents, textures, or asset-index objects; those subsystems do not load built-in asset content from the cache. An operator can explicitly prepare the manifest-verified client jar and asset index:

```sh
packwright-mcp setup-version 26.2 \
  --accept-minecraft-eula \
  --client-assets \
  --workspace /absolute/path/to/workspace
```

This does not download all asset objects, install a client, or redistribute Minecraft files. The MCP server never performs setup or accepts terms on an operator's behalf.
