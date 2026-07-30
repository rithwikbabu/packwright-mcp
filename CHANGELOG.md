# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/rithwikbabu/packwright-mcp/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/rithwikbabu/packwright-mcp/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/rithwikbabu/packwright-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/rithwikbabu/packwright-mcp/releases/tag/v0.1.0
