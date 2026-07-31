# Paired visual compiler

Packwright can associate a Minecraft Java Edition 26.2 datapack with a sibling resource pack and turn a semantic custom-item description into reviewable, deterministic files. The supported workflow is:

```text
describe -> generate draft -> connect behavior -> render -> visually review
         -> targeted repair -> client capture where supported -> validate
         -> explicit commit -> build both packs
```

Draft operations write only to Packwright's local cache. They do not overwrite either pack. `visual_commit` is the single operation that installs an accepted proposal into both workspace packs, and `project_build` creates two separate ZIP artifacts.

## Current scope

Packwright v0.4.0 implements the custom-item vertical slice:

- Paired project manifests for an existing 26.2 datapack and a sibling resource pack using format `88.0`.
- A strict semantic `ModelSpec` for item cuboids, planes, named materials, deterministic UVs, supported element rotations, item-state trees, and display transforms.
- Compilation to `assets/<namespace>/items/<path>.json`, `assets/<namespace>/models/item/<path>.json`, and PNG textures.
- A `minecraft:item_model` binding to a caller-selected vanilla carrier item, with an optional `/give` helper and shaped recipe.
- An asset graph spanning the logical item, carrier, component, client item definition, model, and textures.
- A model-specific scene-review layer over the deterministic CPU renderer. Eight version-1 profiles select bounded held-item, block, placeable, armor, head-wearable, projectile, GUI-item, or entity-model scenes and produce immutable advisory measurement reports.
- Protocol-v3 Minecraft 26.2 framebuffer capture for items and strict block, headwear, entity, and placeable representations, stored separately from CPU evidence with exact representation/pack/runtime/studio/environment provenance. Required views contain stock gameplay/world composition; augmented scale-reference and debug-hitbox frames are explicit opt-ins.
- Immutable repair revisions, including constrained selected-profile metadata repairs, guarded multi-file commit, layered validation, and deterministic paired builds.

The capability matrix separates what Minecraft 26.2 can represent (`status` and `support`) from what Packwright v0.4 can compile (`compilerSupport`). `compilerSupport` is `full` for `custom_item`, `limited` for `conditional_item_state`, and `unsupported` for every other target. The item-state DSL exists, but its property coverage and built-in resolution are not exhaustive. Block models, equipment, paintings and trims, mob variants, display rigs, keyframe animation, GUI/font/sprite authoring, generator subprocess adapters, and multi-asset project heads remain later phases. `author_display_rig` produces a truthful plan; it does not generate commit-ready rig files.

Client capture has its own support boundary. It is `full` for `gui_item`; `limited` for one-handed `held_item`, `block`, `placeable`, `head_wearable`, and `entity_model`; and unsupported for `armor` and `projectile`. The non-item profiles require an explicit strict representation that matches the selected review profile. Capture support does not imply compiler support, and an unsupported strategy is never replaced with a CPU image bearing client authority.

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

v0.4 keeps exactly one active workflow head for each paired project, not one head per asset or run. Creating or repairing a draft advances that head; inspection and operations with omitted run/revision IDs select it, and `project_build` always uses it. `assetId` only filters the active graph returned by inspection; it does not select a historical asset head. Immutable older runs remain content-addressed and addressable by operations or resources that accept exact IDs, but v0.4 does not aggregate several independently active item heads into one project graph.

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
  "reviewProfile": "held_item",
  "heldItem": {
    "primaryGrip": [8, 5.5, 11],
    "muzzle": [8, 15, 8],
    "forwardAxis": [0, 0, -1],
    "handedness": "either",
    "twoHanded": false,
    "itemKind": "weapon",
    "usePose": "aim"
  },
  "connection": {
    "strategy": "minecraft:item_model",
    "carrierItem": "minecraft:stick"
  }
}
```

The current schema supports cuboids and single-axis planes; named parent relationships; element rotations on `x`, `y`, or `z` at Minecraft-supported angles; automatic box UVs or explicit face UVs; colors, external textures, tint indices, transparency, and emissive intent; all standard item display contexts; and condition/select/range/composite item states. Semantic parents name review groups only: each part retains model-space coordinates and its own Minecraft element rotation rather than inheriting an animation transform. Item properties and their codec fields are validated against an explicit 26.2 allow-list; an unknown property, unexpected parameter, or invalid enumerated select value is rejected instead of being copied into client JSON. Emissive intent is recorded but the vanilla item model compiler does not claim true emissive rendering. A custom external texture or item-state model must already exist at `assets/<namespace>/textures/<path>.png` or `assets/<namespace>/models/<path>.json` in the project's sibling resource pack. Packwright does not search dependency packs, Mojang asset objects, the client-assets cache, or another filesystem location to resolve it.

`reviewProfile` selects how the already compiled item model is staged for advisory review; it never changes the Minecraft model JSON. The accepted values are `held_item`, `block`, `placeable`, `armor`, `head_wearable`, `projectile`, `gui_item`, and `entity_model`. Selecting one does not add a block, equipment, projectile, GUI, or entity compiler and does not change the capability matrix. It only chooses deterministic scenes, original Packwright reference geometry, and measurements for the current custom-item compiler output.

Each profile accepts only its matching optional semantic metadata. `heldItem` describes grips, muzzle/axis, handedness, item kind, two-handed intent, and use pose. `blockReview`, `placeableReview`, `armorReview`, `headWearableReview`, `projectileReview`, `guiItemReview`, and `entityModelReview` respectively describe block adjacency/lighting/culling cues, placeable orientations/attachments/footprint, armor slots/body variants/poses, head-wearable bodies/obstruction/armor-stand views, projectile axis/in-hand/impact/stuck intent, GUI counts/durability/glint/tooltip cues, or entity hitbox/pose/scale references. Metadata for a different selected profile is rejected. Omitting applicable metadata uses the profile's bounded defaults or reports a semantic measurement as `skipped`; Packwright does not invent a pass.

## Review profiles

A review profile owns its required and conditional scenes, reference geometry, cameras, reusable measurement rules, and warning/failure thresholds. Minecraft display transforms remain the compiled output. A profile selects the appropriate compiled display transform for each scene while independently posing Packwright-authored references; reference geometry is never written to the resource pack. Every complete scene plan is deterministically ordered and bounded to 16 views.

`held_item@1` always renders these 12 required scenes:

- First-person right hand with Steve and Alex arms.
- First-person left/offhand with Steve and Alex arms.
- First-person right hand at a representative 100-degree wide FOV.
- Third-person rear three-quarter, right hand, with Steve and Alex bodies.
- Third-person front three-quarter, right hand, with Steve and Alex bodies.
- Third-person rear three-quarter, left hand, with Steve and Alex bodies.
- A neutral item-only comparison.

The profile adds up to four conditional scenes, keeping the complete contact sheet within the 16-scene limit:

- `swing_midpoint` for weapon/tool items or `usePose: "swing"`.
- `active_use` for block, bow, crossbow, spear, horn, food, drink, spyglass, brush, or aim use poses.
- `two_handed` when a secondary grip is declared.
- `aiming` when a forward axis or muzzle is declared.

The report measures primary- and secondary-palm grip reach, approximate transformed arm and torso intersection, alpha-weighted first-person screen coverage, forward-axis alignment, mirrored left/right grip-and-orientation delta, and retained projected face area. Each result is `passed`, `warning`, `failed`, or `skipped`. A one-handed declaration still renders both hands for comparison but excludes the undeclared hand from blocking measurements; conditional action scenes use the declared primary hand. These checks have `advisory` authority: a configured failure blocks review readiness and commit, but it is not proof of how every FOV, skin, animation, or client implementation will render.

The other version-1 profiles specialize the same interface:

| Profile         | Specialized scenes                                                                                          | Packwright-authored references and advisory focus                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `block`         | Inventory view, placed-world view, six sides, adjacent blocks, and representative lighting/culling scenes   | Unit block, adjacent blocks, face guides; bounds, adjacency, visibility, and frame retention       |
| `placeable`     | Declared north/east/south/west orientations, floor/wall/ceiling attachments, footprint, and neutral context | Attachment planes and footprint guide; attachment gap, orientation, footprint, and framing         |
| `armor`         | Steve/Alex bodies, declared slots, front/rear/side views, and representative walking/crouching poses        | Original Steve/Alex-shaped body rigs; clearance, clipping, coverage, symmetry, and frame retention |
| `head_wearable` | Steve/Alex head views, first-person obstruction, and armor-stand presentation                               | Original heads, camera mask, and armor stand; clearance, obstruction, symmetry, and framing        |
| `projectile`    | In-hand view, in-flight angles, impact/stuck orientations, and forward-axis context                         | Hand/arm, impact plane, and direction guides; axis alignment, intersection, and framing            |
| `gui_item`      | Inventory and hotbar sizes plus declared count, durability, glint, and tooltip presentation cues            | Original GUI frames and overlays; icon occupancy, edge retention, and text/overlay space           |
| `entity_model`  | Eight-angle turntable, declared pose snapshots, player-scale comparison, and hitbox overlays                | Original player and hitbox guides; scale, hitbox containment, pose framing, and symmetry           |

These references do not copy Mojang artwork or assets. Lighting, culling, collision, attachment, glint, durability, tooltip, equipment fit, projectile motion, animation, and hitbox scenes are deterministic approximations for inspection. They do not run or reproduce the Minecraft client systems named by the scene.

## Exact workflow

1. Call `visual_capabilities` and state the requested target's truthful capability status.
2. Call `visual_project_attach` to associate the existing datapack with a sibling resource pack. Use `dryRun` first when creating either the resource-pack metadata or project manifest.
3. Convert the request into a strict `ModelSpec`, then call `visual_spec_upsert`. Record provider, model/version, prompt, seed when available, and reference hashes in provenance.
4. Call `texture_import` for each supplied material PNG. A missing generated texture is filled deterministically from the material color, or a stable hash-derived fallback when no color is declared.
5. Call `visual_compile`. This writes canonical draft files to the content-addressed run store, not the workspace packs.
6. Call `visual_connect` with a safe vanilla carrier. Review the proposed resource-pack files, `minecraft:item_model` component, helper function, optional recipe, captured destination hashes, and returned `proposalSha256`.
7. Call `visual_render`. Inspect `reviewProfile`, `reviewReady`, the advisory measurements, and the returned contact sheet. Read the immutable render-report resource and individual image resources for ambiguous views.
8. If review finds a defect, call `visual_revision_create` with the parent revision ID, its exact `expectedSpecSha256`, a human-readable finding, and only the named part, material, display-transform, or selected-profile metadata repairs. Compile and render the child revision, then compare the same profile scenes.
9. For a capture-supported profile, call `visual_capture` with the exact current `proposalSha256`, matching strict `representation` when required, and `confirm: true`. The default produces the authoritative Minecraft gameplay/world sheet. Opt into scale-reference or debug-hitbox views only for the separate supplemental QA sheet. Review the representation hash, source-frame hashes, client-pixel measurements, readiness/settling evidence, and environment report; supplemental views never substitute for required evidence.
10. Call `visual_validate`. It validates the exact current uncommitted proposal as an overlay on stable snapshots of the full sibling packs: resource-pack checks see the complete resource-pack snapshot plus proposed files, while vanilla command validation and optional GameTests see the complete datapack snapshot plus its proposal files. Keep vanilla command validation enabled for release evidence and enable GameTests when the datapack has relevant tests. Omit `requireClientCapture` for production defaults, pass `false` only for advisory/fast validation, or pass `true` when unsupported profiles must also fail.
11. After explicit acceptance, call `visual_commit` with `confirm: true`, the exact current `proposalSha256`, and—for capture evidence whose `proposalBindingStatus` is `implemented`—the accepted report's exact `expectedClientCaptureReportSha256`. Block, headwear, entity, and placeable captures currently return `capture_only` QA evidence and cannot authorize the current item-compiler proposal. Commit also requires a current CPU report with no failed measurements and complete evidence. Production commit does not inherit the advisory validation escape hatch.
12. Call `project_build` to revalidate the exact committed datapack and resource-pack snapshots and transactionally install their independent deterministic ZIPs.

Neither the generation, review, nor repair prompts mutate files. An agent must not treat a rendered image as authorization to commit.

## Immutable runs and revisions

Runs live under `<cache>/visual-runs/<run-id>/`. The run ID is derived from canonical request, specification, and provenance hashes. Each repair creates a content-addressed child under `revisions/<revision-id>/`; existing run and revision directories are never edited in place. Textures, compiled proposals, CPU renders/profile reports, client frames/reports/logs, and targeted repair records are stored by content hash, while `<cache>/visual-project-state/` indexes the one active head for each project. A CPU profile report binds its spec hash, compiled-artifact ID, renderer/profile versions, scene-plan hash, required view IDs, individual image hashes, measurements, and readiness result. Client evidence separately binds the exact spec/proposal/manifest/full-pack hashes, capture plan, client/mod hashes, environment, report/sentinel/log, source framebuffer hashes, and normalized image hashes. Changing any bound input makes older evidence stale instead of silently reusing it.

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

`visual_render` uses the CPU-only `packwright-cpu-v2` profile renderer. It consumes the compiler's canonical sorted geometry, exact UV layout, element rotations/rescale behavior, tint intent, and shared display-transform resolution; tessellates cuboids and planes; poses separate reference geometry; projects with fixed profile cameras; z-buffers opaque surfaces; alpha-blends transparency; samples textures with nearest-neighbor filtering; and applies fixed approximate lighting. It does not launch Chromium, Blender, native OpenGL, or Minecraft.

The selected profile determines the scene set instead of forcing every asset through one universal contact sheet. `held_item@1` uses the 12 required and up to four conditional scenes listed above; the seven other profiles resolve only their specialized scenes and declared conditions. Individual views are exposed as PNG resources, and the immutable JSON report is exposed separately. The contact sheet is at most 720 KiB and is returned as MCP image content; render size is 32–256 pixels, every profile is capped at 16 scenes, model scenes are capped at 512 authored parts plus bounded reference geometry, and raster work is bounded.

The renderer is a fast deterministic review aid, not proof of exact client rendering. Intersections and containment use transformed bounds rather than exact mesh, cameras use representative FOVs and poses, and conditional scenes pose the base compiled geometry rather than resolving every active item-state model or gameplay animation. Approximate lighting is not Minecraft lighting; GUI/glint/durability/tooltip scenes are presentation cues; placement, culling, collision, equipment, projectile, animation, and hitbox scenes do not execute the corresponding client or game logic.

## Official-client renderer capture

`visual_capture` is the slower, environment-authoritative visual layer for supported profiles. An operator first runs:

```sh
packwright-mcp setup-version 26.2 \
  --accept-minecraft-eula \
  --client-capture \
  --workspace /absolute/path/to/workspace
```

That setup prepares the complete manifest-hashed official client, asset objects, platform libraries/natives, and pinned Fabric Loader `0.19.3` in the local cache. Packwright distributes only its own MIT-licensed capture-mod JAR; it does not redistribute Minecraft, Fabric Loader, or asset content. Capture then requires Java 25 and an interactive macOS graphical session.

For each operation, Packwright snapshots both source packs, applies the exact uncommitted proposal, writes deterministic staging archives, creates a disposable void-style studio, installs only its bundled capture mod, and launches the client in offline developer mode with multiplayer and chat disabled. The exact resource-pack archive is active at `resourcepacks/packwright-proposal.zip`. The exact datapack archive exists only at the non-loadable provenance path `packwright/provenance/datapack-proposal.zip`; it is hash-bound but never installed, enabled, or selected. Protocol v3 hash-binds an `item_stack`, `native_block_state`, `block_display`, `equippable_head`, `native_entity`, `display_rig`, `native_placeable_block`, or `native_placeable_entity` representation. Each scene binds its target/representation, fixture, studio/render settings, camera pose, biome/time/weather/subject-light and deterministic light-source placement, tick/animation state, settling interval, measurement intents, and comparison scenes. The mod waits for resource/model readiness and at least two rendered client ticks after fixture spawn/update before capture.

Required scenes contain no debug UI, scale grid, injected comparison, or other inspection aid. Every first-person scene is `first_person_vanilla` with no injected arm. Explicit `first_person_scale_reference`, `debug_hitbox_reference`, bare-head and same-frame injected `comparison_reference`, `world_scale_reference`, and empty-subject `measurement_control` aids are `augmented_qa_reference`, remain supplemental, and never satisfy authority. The entity profile's `entity_player_scale` mannequin is explicitly one of those supplemental `world_scale_reference` frames. Ordinary in-world geometry—and an armor stand when it is the actual declared headwear subject—remains authoritative Minecraft evidence. The representation protocol accepts no credentials, command/function, arbitrary NBT, user save, path, mod, shell input, JVM arguments, or executable content.

The final report binds every screenshot to the full representation/proposal/snapshot/runtime/studio/settings/environment identity and source PNG SHA-256. It also attests `hash_bound_not_loaded` for the datapack and `active` for the resource pack, with exact archive paths, hashes, and selected pack IDs. Every view contains an exact, schema-discriminated `observedFixture` read back from live client state plus its canonical SHA-256; a hash-bound echo of the plan is rejected. It records reload/model readiness, fixture evidence, actual settled ticks/rendered frames, and client-pixel measurements with contributing scene/source hashes and `requiredForReadiness`. Non-skipped measurements are computed from actual framebuffers; unavailable geometry metrics are noncritical `skipped` findings rather than copied from CPU advisory output. Only calibrated two-frame checks backed entirely by required authoritative scenes may be readiness-critical. A failed or skipped critical measurement makes capture unready and blocks commit; a critical warning remains visible but ready. Measurements that depend on a supplemental empty-subject control remain noncritical, so an inspection aid cannot become an acceptance condition. Supplemental-only failures remain QA findings. Top-level `authorityScope: "required_views_only"` excludes all supplemental frames. The authoritative contact sheet and generic supplemental QA sheet have separate resources.

Required stock views have `authoritative_environment_capture` authority for the recorded OpenGL environment. Supplemental scale/hitbox/control views are never acceptance substitutes. The runtime records Minecraft's `custom` graphics preset alongside every fixed option because Packwright's deterministic cloud, particle, shadow, and distance settings intentionally override the stock presets. Native block-state capture remains a replacement of an existing block; block displays and composite display rigs are simulated. Headwear is an actually equipped `minecraft:equippable` head item, with exact fallback/equipment-model/camera-overlay semantics and exact optional chest-armor compatibility stacks. Native entity capture uses a vanilla zombie for observable deterministic idle/walk/attack core scenes and restricts additional matrix entries to allow-listed existing types with exact variants/components/equipment; arbitrary entity geometry remains unsupported. Native placeable block fixtures are floor-only and require the declared orientation to equal the block state's `facing` property; wall and ceiling attachment evidence currently requires an explicit simulated display rig. A successful capture proves evidence completeness, not aesthetic approval.

### Protocol-v3 target profiles

| Target      | Required authoritative scenes                                                                                                                                                                        | Conditional authoritative scenes                                                                                        | Supplemental only                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `block`     | Daylight hero; north/south/east/west/up/down; repeated-state adjacency plus opaque neighbor; controlled culling; full-skylight and lower/block-light pair; inventory only when an item form is bound | Bounded state/multipart matrix; light, dark, and overlapping-copy alpha stress; declared biome tints                    | Matched empty-subject measurement control and inspection overlays                                                                  |
| `headwear`  | Actually equipped Steve/Alex front/side/rear at head and full-body scales; stock first person at FOV 70; armor stand when supported                                                                  | Camera overlay; FOV 100; declared crouch/walk/swim/glide, glint, dye, trim, damage, and exact chest-armor compatibility | Required paired bare-head comparison; matched empty-subject measurement control; injected comparisons                              |
| `entity`    | Eight angles; zombie-backed deterministic idle/walk/attack; ground/shadow and ordinary block scale; bounded allow-listed exact variant/equipment/component matrix; fixed short animation samples     | Relevant low-light profile when transparency/emissive intent is declared                                                | `entity_player_scale` mannequin (`world_scale_reference`), matched empty-subject measurement control, and F3+B front/side hitboxes |
| `placeable` | Floor north/east/south/west at eye and close ranges; display-rig wall/ceiling attachments when declared; contact/anchor, footprint/corner/doorway, near/mid-range, and occlusion contexts            | Bounded declared static-state matrix                                                                                    | Matched empty-subject measurement control and interaction/F3+B hitboxes                                                            |

Protocol v3 rejects nonzero display interpolation and block animated-texture tick requests: Minecraft does not expose an authoritative per-capture atlas phase, and Packwright does not yet drive an exact display interpolation phase. Simulated entity rigs therefore bind separate static `idle`, `walk`, and `attack` representation states instead of claiming tick-driven animation.

The measurement report covers applicable framebuffer retention/coverage, pairwise deltas, seams/culling/alpha order, head fit/obstruction, silhouette/grounding/scale/variant resolution, and orientation/contact/z-fighting/occlusion. Thresholds are present only for metrics whose client-pixel units are calibrated; other metrics are explicitly best-effort and may be skipped. The plan marks criticality separately from scene authority. Hitbox and matched empty-subject controls remain supplemental results, do not upgrade their frames to authority, and can never set `requiredForReadiness`.

## Transactional commit and build

`visual_connect` records the SHA-256 or expected absence of every destination. Before changing a pack, `visual_commit` independently re-renders the immutable spec and verified textures, recomputes the selected profile's canonical measurements, and requires the stored CPU report and scene/contact-sheet hashes to match with no failed advisory measurement. For a full/limited client-capture profile in a production workflow, it also requires `expectedClientCaptureReportSha256` to equal the exact current verified environment report, requires `proposalBindingStatus: "implemented"`, and rejects capture-only or measurement-failed evidence. Block, headwear, entity, and placeable captures remain QA-only until the compiler proposal implements their exact representation. Cached status/reference edits therefore cannot manufacture review readiness. It then:

1. Resolves every destination beneath the correct paired pack.
2. Acquires locks in sorted path order.
3. Verifies all proposal content and destination preconditions before changing a file.
4. Stages output beside each destination and records a journal under `.packwright/transactions/`.
5. Installs the files with atomic filesystem operations.
6. Attempts rollback if installation fails and retains the journal when manual recovery is required.

A visual transaction is limited to 512 files and 64 MiB. There is no force flag for stale hashes. Its durable receipt binds the accepted client evidence/source report/plan/client/mod/staged-pack hashes when client authority applies, alongside the proposal, manifest, and output hashes. `project_build` accepts no run/revision selector and requires the project's active revision to have ready textures and compiled artifacts and to be rendered, bound, and committed. It validates the exact current committed snapshots of both packs, not a draft overlay, rechecks that both source snapshots remain unchanged, and emits `<project>-data-26.2.zip` and `<project>-assets-26.2.zip` by default. Both archives are installed through one journaled transaction. The paired source snapshots and paired ZIP payloads are independently limited to 64 MiB combined, so an oversized pair fails before Packwright materializes or installs unusable output. With `overwrite: true`, both `expectedDatapackSha256` and `expectedResourcepackSha256` must be present; each is either the destination's current SHA-256 or `null` when that destination is expected not to exist. The result's `truncated` flag reports whether bounded diagnostics were shortened.

## Validation evidence

`visual_validate` reports these layers independently: paired metadata, schema, texture, asset graph, geometry/UV, CPU render readiness, profile-report evidence, client-capture evidence, binding, vanilla commands, and GameTests. It verifies the immutable CPU report against the current spec, compiled artifact, profile plan, required view hashes, and renderer/profile versions. Client capture is tri-state: omitted requires exact evidence for full/limited support and skips unsupported profiles; `false` is advisory/fast; `true` requires evidence and fails unsupported profiles. Evidence verification never launches the client. It applies the exact uncommitted proposal to stable full-pack snapshots before resource-pack, command, and GameTest checks, so validation evidence covers the bytes proposed for commit rather than only the already committed packs. Semantic diagnostics name an asset and, where possible, its exact part, material, display context, review profile, scene, or measurement.

The current automated visual checks cover strict schema/canonical compilation, required textures, zero-area UV assignments, material/tint conflicts, part relationships, approximate display clipping, graph endpoints/cycles/orphans, the `minecraft:item_model` chain, and the selected profile's advisory measurements. Agent visual review still supplies aesthetic judgment; neither its judgment nor the software-rendered measurements are authoritative Minecraft results. Vanilla-backed command validation remains authoritative for datapack command syntax, while an optional GameTest supplies behavior evidence. Profile choice cannot convert review evidence into support for a compiler target that `visual_capabilities` reports as unsupported.

Client-asset setup is optional for the semantic compiler, CPU renderer, and validator. It remains separate from full client-capture setup and is not a built-in resolver for model parents, textures, or asset-index objects. An operator can explicitly prepare only the manifest-verified client jar and asset index:

```sh
packwright-mcp setup-version 26.2 \
  --accept-minecraft-eula \
  --client-assets \
  --workspace /absolute/path/to/workspace
```

This does not download all asset objects or make capture ready. `--client-capture` performs the larger full-runtime setup described above. Neither path redistributes Minecraft files, and the MCP server never performs setup or accepts terms on an operator's behalf.
