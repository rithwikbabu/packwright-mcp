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

A structural error prevents `datapack_build`. Warnings and informational findings are returned but do not by themselves block packaging. Structural checks remain available without Java through `validate --no-vanilla` or `datapack_validate` with `includeVanilla: false`, but that reduced mode does not prove that Minecraft can parse commands.

## Vanilla-backed command validation

`validate` and `datapack_validate` run vanilla-backed command validation by default. Packwright stages the exact scanned pack and asks the pinned Minecraft 26.2 server runtime to compile every logical command in every `.mcfunction` file. The check uses the target version's real command dispatcher, its loaded registries, and its item/component, text-component, selector, particle, attribute, entity-data, and other command codecs. Pack-defined dynamic registry entries are present while commands are parsed.

Each logical command is placed in its own unreferenced probe function. The staged copies of the pack's original functions are replaced with inert comments, and the isolated harness executes only Minecraft's built-in always-pass test. This lets Minecraft report failures from later lines even when an earlier line is invalid, without executing user-authored functions or accepting a user world path. Temporary packs, reports, logs, and the disposable universe are removed after success, failure, timeout, or cancellation.

Vanilla diagnostics are mapped back to the original file and physical line. Human-readable output is line-oriented:

```text
spell/chain/cast.mcfunction:12
Unknown particle `minecraft:electric`
Did you mean `minecraft:electric_spark`?
```

The parse failure is authoritative Minecraft evidence. A `Did you mean` suggestion is a deterministic heuristic over identifiers in the verified cached 26.2 reports, not a message or guarantee from Minecraft; review it before applying a change.

This check validates syntax and codec parsing, not runtime state or behavior. It cannot prove that an objective, entity, storage value, scheduled function, or world condition will exist when a command executes. Function macro lines beginning with `$` are template-checked by Minecraft, but substituted commands cannot be fully dispatched until runtime arguments are supplied; Packwright reports those lines as deferred informational diagnostics. Use GameTests for stateful behavior and retain code review for data whose meaning is only established at runtime.

Vanilla-backed command validation requires the verified 26.2 cache and Java 25. Without them, default validation returns `setup_required`. The CLI's `--no-vanilla` flag and the MCP input's `includeVanilla: false` are explicit validation-only escape hatches for offline structural work. `datapack_build` and the `build` CLI command always run vanilla command validation and have no bypass; missing setup or any authoritative command error prevents the ZIP from being produced.

Validation is fail-closed rather than partial: a pack with more than 20,000 logical command probes is rejected with an explicit limit diagnostic instead of silently leaving later commands unchecked. The existing 20,000-file, 512-MiB scan and 4-MiB text-resource limits also apply.

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
5. Prepares command/registry reference reports used by lookup, diagnostic suggestions, and vanilla-backed command validation.

The jar and generated data are cache entries, not project files, npm package contents, GitHub artifacts, or release assets. Setup fails when offline mode is enabled or verification does not match.

Run `packwright-mcp doctor --workspace /absolute/path/to/datapacks` to see Node, workspace, Java, cache, and validator readiness.

## Disposable GameTest runs

`datapack_test` and the matching CLI command copy the selected pack into temporary staging and launch Java 25 using Mojang's official `net.minecraft.gametest.Main` entrypoint. Packwright supplies the pack, report, test selector, and a freshly allocated `--universe` path.

The vanilla runner may replace its universe directory. For that reason Packwright never accepts a user save as the universe and never reuses a caller-provided world directory.

Packwright parses JUnit-style output and bounded server logs into structured cases. On completion, failure, five-minute default timeout, or MCP cancellation, it terminates the child process and removes disposable state. A missing jar or incompatible Java returns `setup_required`; it does not trigger a download.

Function-type GameTests reference entries in Minecraft's internal `test_function` registry. A datapack `.mcfunction` file does not register such an entry, so Packwright's vanilla-only validator rejects custom-namespace Test Function IDs. Use a known vanilla Test Function such as `minecraft:always_pass` only for runner smoke coverage. Behavior-focused datapack tests must use `block_based` test instances with an existing binary structure containing Test Blocks; Packwright v1 inventories and packages binary structures but does not author them.

## Interpreting results

Validation authority increases from left to right:

```text
Packwright structural checks -> Spyglass static diagnostics -> vanilla command parser -> vanilla GameTest
```

A passing structural or Spyglass result is not proof that Minecraft can parse every command. Vanilla-backed validation closes that gap for command syntax and codecs, but it still does not execute commands or prove runtime state. Use a vanilla test for release-critical predicates, scheduled behavior, world-state interactions, and GameTest resources. Conversely, a GameTest run only exercises selected behavior; retain structural validation, command validation, and code review.

## Continuous integration

Ordinary CI never downloads Minecraft artifacts. The repository's separate `Minecraft integration` workflow is manual, uses a protected GitHub environment, requires an explicit EULA-acceptance input, and never uploads the server jar or generated vanilla cache. Its acceptance path creates a new pack, adds a load function and an explicit `minecraft:always_pass` runner smoke test, validates it, passes the selected vanilla test, builds a deterministic ZIP, extracts that artifact, and loads the built contents through the vanilla runner again.

For an explicitly approved local run, set an isolated absolute cache and the acceptance guard yourself:

```sh
PACKWRIGHT_CACHE_DIR=/absolute/path/to/disposable/cache \
PACKWRIGHT_ACCEPT_MINECRAFT_EULA=true \
npm run test:minecraft
```
