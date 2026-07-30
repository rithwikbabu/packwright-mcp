# Validation and vanilla testing

Packwright separates checks it owns from diagnostics supplied by external tooling and results observed from vanilla Minecraft. Each diagnostic identifies its engine and authority so clients do not confuse a heuristic with a game result.

## Structural validation

Structural validation is deterministic, offline-capable, and always available. It checks at least:

- `pack.mcmeta`, including Minecraft 26.2 format bounds.
- Singular 26.2 resource-directory names and allowed extensions.
- JSON syntax, supported text extensions, and valid UTF-8/NUL-free MCFunction and SNBT text.
- Basic balanced SNBT delimiters and terminated strings; this is not a full SNBT grammar check.
- Namespace and resource-location syntax.
- Duplicate resource identities.
- Load and tick tag references.
- Unsafe paths, symlink escapes, and scan limits.
- ZIP root layout before or during a build.

A structural error prevents `datapack_build`. Warnings and informational findings are returned but do not by themselves block packaging.

## Spyglass diagnostics

When an operator explicitly configures a trusted external executable through `PACKWRIGHT_SPYGLASS_COMMAND`, Packwright first requires the compatibility-pinned `0.4.65` version, then sends supported MCFunction, JSON, MCMETA, and SNBT documents across Spyglass's stdio LSP boundary and normalizes the returned diagnostics.

Spyglass is a complementary static analyzer, not the authority for whether Minecraft 26.2 will load a pack. It is not installed, downloaded, or enabled by Packwright. If no external command is configured, Packwright reports that state and still completes its owned structural validation. Packwright's SNBT checks intentionally stop at encoding, NUL, delimiter, and string-termination safety; use a reviewed external analyzer or vanilla testing for full language semantics. Packwright does not vendor Spyglass data or `misode/mcmeta` content.

## One-time 26.2 setup

Setup is intentionally outside MCP tool access. An operator must have Java 25 installed and explicitly accept the Minecraft EULA:

```sh
packwright-mcp setup-version 26.2 \
  --accept-minecraft-eula \
  --workspace /absolute/path/to/datapacks
```

The command:

1. Resolves Mojang's official 26.2 version manifest.
2. Downloads the official server jar into the configured local cache.
3. Verifies the jar against the SHA-1 in Mojang's manifest before use.
4. Records the operator's EULA acceptance locally.
5. Prepares command/registry reference reports used by lookup and deep validation.

The jar and generated data are cache entries, not project files, npm package contents, GitHub artifacts, or release assets. Setup fails when offline mode is enabled or verification does not match.

Run `packwright-mcp doctor --workspace /absolute/path/to/datapacks` to see Node, workspace, Java, cache, and validator readiness.

## Disposable GameTest runs

`datapack_test` and the matching CLI command copy the selected pack into temporary staging and launch Java 25 using Mojang's official `net.minecraft.gametest.Main` entrypoint. Packwright supplies the pack, report, test selector, and a freshly allocated `--universe` path.

The vanilla runner may replace its universe directory. For that reason Packwright never accepts a user save as the universe and never reuses a caller-provided world directory.

Packwright parses JUnit-style output and bounded server logs into structured cases. On completion, failure, five-minute default timeout, or MCP cancellation, it terminates the child process and removes disposable state. A missing jar or incompatible Java returns `setup_required`; it does not trigger a download.

## Interpreting results

Validation authority increases from left to right:

```text
Packwright structural checks -> Spyglass static diagnostics -> vanilla pack load/GameTest
```

A passing static validation is not proof that every runtime path works. Use a vanilla test for release-critical commands, predicates, scheduled behavior, and GameTest resources. Conversely, a GameTest run only exercises selected behavior; retain structural validation and code review.

## Continuous integration

Ordinary CI never downloads Minecraft artifacts. The repository's separate `Minecraft integration` workflow is manual, uses a protected GitHub environment, requires an explicit EULA-acceptance input, and never uploads the server jar or generated vanilla cache. Its acceptance path creates a new pack, adds a load function and GameTest, validates it, passes the selected vanilla test, builds a deterministic ZIP, extracts that artifact, and loads the built contents through the vanilla runner again.

For an explicitly approved local run, set an isolated absolute cache and the acceptance guard yourself:

```sh
PACKWRIGHT_CACHE_DIR=/absolute/path/to/disposable/cache \
PACKWRIGHT_ACCEPT_MINECRAFT_EULA=true \
npm run test:minecraft
```
