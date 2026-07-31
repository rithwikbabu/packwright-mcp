# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-07-31

### Added

- Extended official Minecraft 26.2 client capture to native block-state bindings, simulated `block_display` models, equippable head items and equipment layers, supported vanilla entity variants/components, and strict declarative placeable display rigs.
- Added protocol-v3 representation bindings, deterministic disposable studio fixtures, live client readbacks, framebuffer-derived measurements, exact observed-fixture hashes, and target-specific block, headwear, entity, and placeable scene profiles.
- Added conditional captures for block state and tint matrices, transparency and light stress, camera overlays and equipment compatibility, supported entity states, and placeable attachments and interpolation declarations.

### Changed

- Client evidence now binds the exact representation strategy, state/components/equipment or display transforms, proposed pack snapshots, runtime and renderer settings, studio environment, camera and animation state, framebuffer source, and every artifact hash.
- Blocks, headwear, entities, and placeables report honest native, simulated, limited, or unsupported capabilities. Their current compiler integration is `capture_only` and cannot authorize an item-compiler commit.
- Actual Minecraft OpenGL rendering is authoritative for required gameplay/world frames. CPU renders remain advisory, while debug hitboxes, bare-head controls, measurement controls, injected comparisons, and other inspection aids are supplemental QA only.

### Security

- Display rigs accept only strict declarative manifests compiled into allow-listed setup actions with bounded post-spawn settling; arbitrary commands, functions, saves, mod paths, executable content, credentials, and unapproved paths fail before launch.
- Protocol-v3 verification rejects stale proposal/report bindings, incomplete required/supplemental partitions, missing runtime or renderer bindings, artifact tampering, and any attempt to substitute augmented QA evidence for an authoritative frame.

## [0.4.1] - 2026-07-31

### Changed

- Upgraded the official-client capture wire format to protocol version 2. Every frame now carries a hash-bound `viewKind`, `baseSceneId`, and `requiredForAuthority` identity.
- Required `first_person_vanilla` views use stock gameplay composition with no Packwright-injected arm and form the authoritative contact sheet.
- MCP `includeScaleReferenceViews: true` and CLI `--include-scale-reference-views` add separately labeled `first_person_scale_reference` frames and a distinct QA contact sheet. These augmented views have `augmented_qa_reference` authority and never satisfy capture acceptance.
- Client-capture results now declare `authorityScope: "required_views_only"`; result validation rejects relabeled, unclassified, overlapping, or incompletely represented required/supplemental views and mismatched scale-reference sheets.

### Migration

- A committed v0.4.0 visual revision cannot be recaptured in place. Create a child with `visual_revision_create`, run `visual_connect` again, capture it with `visual_capture`, and recommit it with `visual_commit` so the new protocol-v2 evidence and vanilla-first-person composition are bound to a new immutable receipt.

### Security

- Capture plans require every augmented scale-reference scene to have an otherwise identical vanilla first-person pair. The capture mod proves zero Packwright reference-arm submissions for vanilla frames and matching submissions for requested QA frames.
- Stored evidence, workflow indexes, MCP resources, and regenerated contact sheets preserve the authoritative/supplemental split and reject stale protocol-v1 or relabeled evidence.

### Fixed

- First-person screenshots are now WYSIWYG by default: an empty offhand produces only Minecraft's normal main-hand composition. The optional extra arm is no longer presented to agents as gameplay output.

## [0.4.0] - 2026-07-31

### Added

- Added eight versioned visual review profiles: `held_item`, `block`, `placeable`, `armor`, `head_wearable`, `projectile`, `gui_item`, and `entity_model`, each with specialized bounded scenes and Packwright-authored reference geometry.
- Added profile-specific semantic metadata, immutable render reports, MCP image/report resources, targeted metadata repairs, and guarded advisory checks spanning held fit, placement, GUI occupancy, armor/head presentation, projectile direction, scale, hitboxes, and frame retention.
- Added the explicitly configured `visual_capture` workflow for hash-bound framebuffer evidence from the actual official Minecraft 26.2 client renderer, with dedicated report, contact-sheet, and individual-view MCP resources.
- Added a client-only Fabric capture mod, a strict versioned plan/report protocol, complete manifest-hashed launcher runtime setup, resource reload/model-bake coordination, fixed offline launch arguments, and capture provenance covering the exact packs, item components, client/mod identities, graphics environment, and PNG hashes.

### Changed

- The visual renderer now compiles model-specific profile scenes instead of applying one universal contact sheet to every semantic item, while leaving Minecraft display transforms and compiled pack JSON unchanged. Selecting a review profile does not expand the item-only compiler or native capability claims.
- Visual commit, validation, and paired build now verify the exact renderer/profile versions, scene plan, report, required image hashes, and advisory readiness result for the selected revision.
- The deterministic CPU renderer remains the portable, advisory first gate. Official-client screenshots have the distinct `authoritative_environment_capture` authority for their recorded OS/GPU/driver/OpenGL environment and are not represented as cross-GPU pixel-deterministic output.
- Official-client capture is `limited` for one-handed `held_item` scenes and `full` for `gui_item`. Two-handed held items are rejected until the adapter can pose and verify a secondary Minecraft-rendered arm at `secondaryGrip`; the other six review profiles report `unsupported` and never substitute synthetic images for Minecraft frames.
- Production validation now requires verified client evidence by default for capture-supported profiles, while `requireClientCapture: false` explicitly selects advisory/fast validation. Production commit requires the exact current capture-report SHA-256 and binds the accepted plan, source report, runtime manifest, client/mod, and pack hashes into its durable receipt.

### Security

- Client setup is an explicit EULA-accepting CLI action that verifies the official client, asset objects, libraries, natives, and pinned Fabric Loader `0.19.3`; Minecraft artifacts are cached locally and never redistributed.
- Client capture launches only the bundled Packwright capture mod in a disposable game directory, accepts no account credentials, user save path, arbitrary command, JVM arguments, or shell input, and disables multiplayer and chat.
- Capture evidence binds the immutable proposal and pack snapshots to the client JAR, capture-mod, framebuffer, report, completion-sentinel, and bounded log hashes; stale or tampered evidence fails verification.

### Fixed

- Advisory held-item CPU evidence now honors one-handed declarations, uses the declared primary hand for action scenes, independently measures secondary-grip reach, alpha-weights screen obstruction, preserves omitted Minecraft model faces, and measures retained projected face area instead of sampling only face vertices. Official first-person frames sign their Minecraft-rendered reference arm as `scale_only` and make no palm-to-grip authority claim.

## [0.3.0] - 2026-07-30

### Added

- Added paired datapack/resource-pack projects for Minecraft Java Edition 26.2, including resource-pack format `88.0` and optional verified client-asset setup.
- Added a truthful capability matrix that distinguishes native, simulated, replacement, and mod-required visual targets without presenting display-based approximations as new blocks or entities.
- Added the first visual-compiler vertical slice for custom items: strict semantic `ModelSpec` drafts, deterministic Minecraft item definitions/models, generated or imported PNG textures, `minecraft:item_model` bindings, recipe and `/give` proposals, and cross-pack asset graphs.
- Added 12 visual MCP tools, image and JSON resources, and five non-mutating prompts for generation, review, repair, connection, and display-rig planning.
- Added an immutable content-addressed generation run store with provenance, targeted semantic revisions, render/review artifacts, and SHA-guarded commit proposals.
- Added a deterministic CPU renderer with eight turntable views, inventory and display-context previews, and MCP contact-sheet image responses.

### Changed

- `VersionProfile` now composes server datapack, client resource-pack, and visual capability profiles while retaining the existing datapack tool contracts.
- `project_build` now requires the latest accepted visual revision to be compiled, rendered, connected, validated, and committed, then installs both deterministic ZIPs in one journaled transaction.
- Project and artifact inspection now verifies referenced cached artifacts and committed workspace hashes instead of trusting workflow-state pointers.
- The protected Minecraft integration workflow now exercises the paired custom-item draft, deterministic render, targeted repair, binding, vanilla command validation, GameTest, transactional commit, and byte-identical dual-build path.

### Security

- Added confined PNG decoding and deterministic metadata stripping with file, dimension, pixel, and decoded-byte limits.
- Bound accepted proposals to the exact project-manifest hash and pack paths, revalidate before commit, and reject stale, redirected, or incomplete proposals.
- Added sorted multi-file locks, optimistic SHA-256 preconditions, same-directory staging, transaction journals, and rollback for cross-pack commits.
- Rejected symlinked visual state roots and scoped revision identities to their immutable generation runs.
- Namespaced cached workflow state and operation locks by canonical workspace identity, and rejected any workspace/cache overlap, including symlink aliases.
- Added durable workspace commit receipts so an interrupted cache-state update can be reconciled only after the exact proposal, manifest, outputs, and retained-journal state are verified.
- Switched transaction installation and rollback restoration to atomic no-replace links with parent identity revalidation, preserving concurrent writers and recovery artifacts on races.
- Added a fail-closed Minecraft 26.2 allow-list for compiled item-state properties, codec parameters, and enumerated select values.

### Fixed

- Preserved the latest revision when compiling, rendering, connecting, or committing an explicitly selected older revision.
- Made concurrent derived operations merge state safely instead of erasing render, binding, or commit metadata.
- Tracked imported versus generated texture provenance and invalidated generated textures when a material repair changes its appearance.

## [0.2.0] - 2026-07-30

### Added

- Added default vanilla-backed validation for every logical `.mcfunction` command using Minecraft 26.2's real dispatcher, loaded datapack registries, and component codecs.
- Added authoritative source-line diagnostics and deterministic heuristic suggestions from the verified cached command/registry reports.
- Added an explicit `--no-vanilla`/`includeVanilla: false` escape hatch for structural-only validation, with deferred reporting for runtime-substituted function macros.

### Changed

- Builds now require Java 25, prior operator-run Minecraft 26.2 setup, and successful vanilla command validation; build has no bypass for authoritative command errors or missing setup.
- Vanilla command parsing runs in isolated disposable staging without executing user-authored functions.
- The GameTest timeout is now one shared budget across mandatory command prevalidation and the selected vanilla tests.

### Fixed

- Matched Minecraft's Java line trimming, comment continuation, UTF-8 BOM, line-length, and physical-source mapping semantics to avoid validator-only acceptance or rejection.
- Parsed the nested JUnit suite shape emitted by the Minecraft 26.2 GameTest runner.

## [0.1.2] - 2026-07-30

### Fixed

- Carried forward the `0.1.1` vanilla GameTest corrections in a publishable release.
- Corrected the npm release tarball path so npm treats the downloaded artifact as a local package instead of a Git repository shorthand.

## [0.1.1] - 2026-07-30

### Withdrawn

- The immutable tag passed CI and vanilla Minecraft testing, but publication stopped before npm, MCP Registry, or GitHub release artifacts were created. Use `0.1.2` instead.

### Fixed

- Corrected the vanilla Minecraft acceptance flow to use the built-in `minecraft:always_pass` Test Function instead of treating a datapack `.mcfunction` as a GameTest Test Function.
- Added structural diagnostics and MCP authoring guidance for vanilla-only GameTest function constraints.

## [0.1.0] - 2026-07-30

### Added

- Initial stdio MCP server for Minecraft Java Edition 26.2 datapacks.
- Safe datapack and resource creation, reading, editing, deletion, and inspection.
- Built-in structural validation and an opt-in adapter for an externally managed Spyglass process.
- Local Minecraft reference lookup and explicit vanilla 26.2 setup.
- Disposable GameTest execution and deterministic ZIP builds.
- CLI commands for serving, diagnostics, setup, validation, tests, and builds.

### Security

- Excluded Spyglass from runtime dependencies because its current dependency tree contains an unfixed critical archive-extraction advisory; external use requires explicit operator configuration.

[Unreleased]: https://github.com/rithwikbabu/packwright-mcp/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/rithwikbabu/packwright-mcp/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/rithwikbabu/packwright-mcp/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/rithwikbabu/packwright-mcp/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/rithwikbabu/packwright-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/rithwikbabu/packwright-mcp/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/rithwikbabu/packwright-mcp/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/rithwikbabu/packwright-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/rithwikbabu/packwright-mcp/releases/tag/v0.1.0
