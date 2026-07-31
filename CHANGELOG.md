# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/rithwikbabu/packwright-mcp/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/rithwikbabu/packwright-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/rithwikbabu/packwright-mcp/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/rithwikbabu/packwright-mcp/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/rithwikbabu/packwright-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/rithwikbabu/packwright-mcp/releases/tag/v0.1.0
