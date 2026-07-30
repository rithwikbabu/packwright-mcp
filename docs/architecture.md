# Architecture

Packwright keeps protocol concerns separate from datapack rules and side effects. The split makes new Minecraft version profiles possible without changing stable MCP contracts.

## Request flow

```text
stdio transport
  -> strict MCP schemas and registration
  -> application service
  -> datapack/version domain
  -> confined filesystem, validation, vanilla runner, or ZIP builder
```

The MCP layer validates request and response shapes, supplies annotations, exposes resources/prompts, and converts expected domain failures into structured tool errors. It does not implement path policy or write files directly.

The application service coordinates operations and enforces read-only mode. Domain modules own Minecraft identifiers, resource-directory mappings, metadata, diagnostics, and normalized result types. Side-effect adapters own filesystem confinement, optional external LSP communication, downloads, Java processes, and archive creation.

## Version profiles

Version-dependent behavior is represented by a `VersionProfile`. The 26.2 profile declares:

- Datapack format `107.1`.
- Required Java major `25` for vanilla validation.
- Singular resource-directory mappings.
- Supported registries and resource types.
- Experimental feature flags.

Public tools select a supported version but do not expose internal directory rules. A future profile can therefore map the same resource identity differently without changing tool names or general result shapes. V1 intentionally rejects every version other than 26.2.

## Filesystem transactions

All pack paths begin at the canonical workspace. The confinement adapter normalizes input, rejects absolute/traversal paths, checks real ancestors and symlinks, and verifies the final target remains beneath both workspace and pack root.

Mutations are serialized by target path. A write is prepared in the target directory and committed using atomic rename, after checking any required expected SHA-256. Build scanning shares the same confinement and capacity limits.

## Validation authority

Packwright-owned structural rules always run. An external Spyglass executable can be configured by the operator for complementary LSP diagnostics, but is not a dependency or source of authority. By default, validation then compiles every logical `.mcfunction` command with the pinned Minecraft 26.2 runtime's real command dispatcher, pack-aware registries, and component codecs. Vanilla parse failures are authoritative; Packwright-generated identifier suggestions remain heuristics over the verified cached reports.

The command-validation adapter receives the same stable scan snapshot used by structural validation. It stages the pack, replaces original function bodies with inert placeholders, and creates one unreferenced synthetic function for each logical command. A random-namespace always-pass harness causes vanilla to load and compile every probe independently without executing a user function. This preserves source-line mapping and allows failures after an invalid earlier line to be reported. The adapter launches a fixed Java 25 entrypoint with controlled arguments, bounds and parses the official logs, honors cancellation/timeout, verifies that the source snapshot did not change, and cleans all disposable state. It never receives a user world path.

This layer establishes dispatcher and codec validity, not runtime behavior. Macro templates can be checked, but their substituted command is deferred until arguments exist. Objective/entity/storage existence, conditional outcomes, scheduling, and side effects still require focused GameTests or review. Vanilla pack loading and GameTest execution therefore remain the highest-confidence behavior evidence and explicit local operations.

Operators can disable the vanilla command adapter only for a `validate` request, preserving an offline structural-analysis path. Public build operations always include it and fail closed when Java 25, the verified cache, the harness result, or a command is invalid.

## Packaging

The build adapter refuses packs with structural or authoritative vanilla command errors, sorts archive entries, fixes ZIP metadata that would otherwise vary, and places `pack.mcmeta` at the archive root. Build has no vanilla-validation bypass. The returned size and SHA-256 let callers verify and compare artifacts.
