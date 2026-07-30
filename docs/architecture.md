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

Packwright-owned structural rules always run. An external Spyglass executable can be configured by the operator for complementary LSP diagnostics, but is not a dependency or source of authority. Vanilla pack loading and GameTest execution provide the highest-confidence runtime evidence and remain explicit, local operations.

The vanilla adapter stages input, allocates a disposable universe, launches a fixed Java entrypoint with controlled arguments, bounds logs, parses reports, honors cancellation/timeout, and cleans temporary state. It never receives a user world path.

## Packaging

The build adapter refuses packs with structural errors, sorts archive entries, fixes ZIP metadata that would otherwise vary, and places `pack.mcmeta` at the archive root. The returned size and SHA-256 let callers verify and compare artifacts.
