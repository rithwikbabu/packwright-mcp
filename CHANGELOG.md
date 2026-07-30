# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-07-30

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

[Unreleased]: https://github.com/rithwikbabu/packwright-mcp/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/rithwikbabu/packwright-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/rithwikbabu/packwright-mcp/releases/tag/v0.1.0
