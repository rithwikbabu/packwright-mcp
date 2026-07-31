# Troubleshooting

Start with a structured environment report:

```sh
packwright-mcp doctor --workspace /absolute/path/to/datapacks
```

Add `--json` when capturing output for automation. Logs belong on stderr; unexpected text on stdout usually comes from a wrapper around the MCP process.

## Server exits at startup

Confirm the configured workspace is an existing absolute directory and the process can read it. Do not use `~`, a relative path, or a file path.

If using an MCP client configuration, check that `PACKWRIGHT_WORKSPACE` is inside the server's `env` object, or pass `--workspace` after `serve`. Restart the client after changing configuration.

## A path is rejected

Pack and resource paths are relative to the workspace. Packwright rejects absolute paths, `..`, encoded traversal, and symlinks that resolve outside the boundary. A resource operation also needs a valid `pack.mcmeta` at its pack root.

Move the pack into the configured workspace or choose a narrower workspace that directly contains it. Do not work around confinement with symlinks.

For paired visual projects, the datapack and resource pack must be distinct sibling directories. The project ID must use normalized lowercase letters, digits, dashes, or underscores, and Packwright owns only `.packwright/projects/<id>.json` for the association.

## An overwrite or delete reports a stale hash

Another process or client changed the file after it was read. Read the resource again, review the new content, and retry with its new SHA-256 only if the mutation is still correct. Packwright intentionally has no force option that bypasses this check.

## Validation says the external validator is unavailable

Built-in structural validation still completed. Spyglass is optional, externally managed, and disabled by default.

Only after independently reviewing and installing a safe executable, set `PACKWRIGHT_SPYGLASS_COMMAND` in the server process environment and restart it. Never accept a validator command from an MCP prompt or tool argument.

## Validation, build, lookup, or vanilla testing returns `setup_required`

Run explicit setup as the operator, not through MCP:

```sh
packwright-mcp setup-version 26.2 \
  --accept-minecraft-eula \
  --workspace /absolute/path/to/datapacks
```

Setup cannot run under `PACKWRIGHT_OFFLINE=true`. If a custom cache is configured, use the same `PACKWRIGHT_CACHE_DIR` for setup and the MCP server.

Default `validate` and every `build` use the cached official runtime; setup is therefore required even when no GameTest is requested. For temporary structural-only analysis, use `validate --no-vanilla` or call `datapack_validate` with `includeVanilla: false`. Build intentionally has no equivalent bypass.

If only the optional `minecraft_client_assets` doctor check is not ready, the current custom-item compiler and CPU renderer can still run. Prepare client-reference setup and readiness data explicitly only when needed:

```sh
packwright-mcp setup-version 26.2 \
  --accept-minecraft-eula \
  --client-assets \
  --workspace /absolute/path/to/datapacks
```

This caches the manifest-verified client jar and asset index, not all client asset objects. It does not make official-client capture ready.

If `minecraft_client_capture` is not ready, prepare the full platform-specific runtime explicitly:

```sh
packwright-mcp setup-version 26.2 \
  --accept-minecraft-eula \
  --client-capture \
  --workspace /absolute/path/to/datapacks
```

Use the same `PACKWRIGHT_CACHE_DIR` and `PACKWRIGHT_JAVA` as the MCP server. This option implies client-assets setup and downloads every indexed 26.2 asset object plus required libraries, natives, and pinned Fabric Loader dependencies. An interrupted setup is safe to repeat; verified content-addressed files are reused. A digest, size, symlink, or incomplete-manifest failure remains `setup_required` rather than being ignored.

## Java is missing or incompatible

Minecraft Java Edition 26.2 command validation, builds, GameTests, and official-client capture require Java 25. Set `PACKWRIGHT_JAVA` to the Java 25 executable when it is not first on `PATH`, then rerun `doctor`. Normal authoring, CPU rendering, and explicit structural-only validation do not need Java.

## A vanilla command diagnostic includes `Did you mean`

The command rejection and its source range come from Minecraft 26.2's real parser. The suggested replacement is Packwright's deterministic heuristic over identifiers in the verified cached registry/command reports; it is not a correction supplied or guaranteed by Minecraft. Review the proposed identifier and its intended semantics before editing the pack.

If a function macro receives a deferred informational diagnostic, Minecraft validated its macro template but could not parse the final substituted command without runtime arguments. Likewise, a clean parse does not establish that an objective, entity, storage value, or other required world state will exist. Exercise those cases with focused GameTests.

## A GameTest times out

Check the bounded stderr/log excerpt for pack load errors, a selector that never completes, or insufficient runner resources. Narrow the selected tests before raising the timeout. Packwright terminates the Java child and cleans its disposable universe on timeout or cancellation.

## A GameTest reports a missing test function

Do not point a function-type `test_instance` at a datapack `.mcfunction`. Vanilla resolves that field through its internal `test_function` registry, which datapacks cannot extend. Use a known vanilla Test Function only for smoke coverage, or use a `block_based` test with an existing binary structure containing Test Blocks.

## A build is refused

Run default `validate` and resolve both structural and vanilla command errors first. Also confirm Java 25 and the prepared 26.2 cache are available, check the 20,000-file/512-MiB scan limits and 20,000-logical-command probe limit, and confirm the output location is permitted. Build always runs vanilla command validation and cannot be forced past missing setup or an authoritative parse error. Warnings and informational macro findings alone do not block a build.

For `project_build`, both associated packs must have compatible metadata: datapack format `107.1` and resource-pack format `88.0`, and the project's one active workflow head must have ready textures and compiled artifacts and be rendered, bound, and committed. A production commit of a capture-supported profile must already have accepted the exact verified client report hash. Packwright validates exact stable snapshots of both committed packs rather than a draft overlay, creates both ZIPs, and installs them in one transaction. With `overwrite: true`, supply both expected fields. Use the current SHA-256 for an output that exists and `null` for an output that is expected to be absent; Packwright does not accept only one precondition. A true `truncated` result means the bounded diagnostic list was shortened, not that either ZIP was partial.

## A visual target is reported as simulated or `requires_mod`

Treat the capability response literally. `simulated` means a vanilla carrier/display/datapack approximation, not a native new block or entity. `requires_mod` means vanilla cannot produce a faithful identity. That Minecraft boundary is separate from `compilerSupport`, which says whether this Packwright release can compile the target. Do not rename the result or suppress its disclosure to make it appear native or implemented.

The current automatic compiler reports `compilerSupport: full` for `custom_item`, `limited` for `conditional_item_state`, and `unsupported` for every other target. The item-state DSL exists, but its property coverage and built-in resolution are not exhaustive. Capability entries for blocks, equipment, variants, mobs, display rigs, animation, and GUI assets describe the target-version boundary and planned binding strategy, not an implemented generator. `author_display_rig` is plan-only.

## `texture_import` rejects a PNG

Confirm the source is an actual PNG, not a renamed JPEG/WebP. Workspace sources need an exact current SHA-256 and cannot be symlinks. Imported files must be 8-bit, non-interlaced PNGs within 8 MiB, 4,096 pixels per axis, 16,777,216 total pixels, and 64 MiB decoded RGBA data. Invalid CRCs, chunk ordering, unknown critical chunks, trailing bytes, malformed palettes/transparency, or excessive decompression are rejected.

For base64 input, the encoded request must also fit the one-MiB MCP payload budget. Use the hash-guarded workspace-file source for larger valid images.

## Visual compilation reports a missing texture

Call `visual_asset_inspect` to find the exact material and expected dimensions. Import a matching PNG for that material, or give the material a color and let compilation generate a deterministic solid texture. Without a color, compilation uses a stable hash-derived fallback. A namespaced custom external texture or item-state model must already exist at `assets/<namespace>/textures/<path>.png` or `assets/<namespace>/models/<path>.json` in the sibling resource pack. Packwright does not search dependency packs, the client-assets cache, Mojang asset objects, or another filesystem location for it.

## A render is clipped or differs from Minecraft

Use individual view resources to identify the failing semantic display context, then create a targeted child revision with `visual_revision_create`. Reduce its scale/translation or adjust the named part; compile and render again before acceptance.

The CPU preview is deterministic and approximate. It does not run the actual Minecraft client and does not provide full special-model rendering. A clean CPU contact sheet therefore needs agent review and is not authoritative client-render evidence.

For a current `held_item` or `gui_item` proposal, prepare client capture and call `visual_capture` (or the CLI `capture` mirror) after CPU review. The authoritative client contact sheet contains stock Minecraft views; `first_person_vanilla` has no Packwright-injected arm. Compare its bounded normalized preview resources against the source-frame hashes in the report; Packwright never silently replaces these with CPU images.

No scale-reference sheet is expected by default. Set MCP `includeScaleReferenceViews: true` or CLI `--include-scale-reference-views` only when a separate scale/occlusion QA comparison is useful. Its `first_person_scale_reference` frames are augmented, non-WYSIWYG references and cannot establish how the item actually appears in stock gameplay or replace a missing required view.

## Official-client capture returns `setup_required`

Run `doctor` and inspect `minecraft_client_capture`. All of these must be true:

- `setup-version 26.2 --accept-minecraft-eula --client-capture` completed in the same cache.
- `PACKWRIGHT_JAVA` resolves to Java 25.
- The installed npm package contains `capture-mod/runtime/packwright-capture-mod-0.4.1.jar`.
- The process is running in an interactive macOS graphical session that can create a real OpenGL window.

Remote shells, headless launch agents, Linux CI, and macOS sessions without an active WindowServer are intentionally not treated as capture-ready. Packwright does not emulate a display or fall back to its software renderer. If `PACKWRIGHT_OFFLINE=true`, rerun setup without offline mode; capture itself remains offline once the cache is complete.

## Official-client capture says the profile is unsupported

Client capture is `limited` for `held_item` and `full` for `gui_item` in v0.4. A held-item spec with `twoHanded: true` intentionally fails until the adapter can pose and verify the secondary gameplay hand at `secondaryGrip`. `block`, `placeable`, `armor`, `head_wearable`, `projectile`, and `entity_model` intentionally fail because their compiler/binding strategies are not present. Changing the profile name to bypass this result would misrepresent the generated item as another Minecraft target; use the profile's CPU evidence or wait for its truthful client implementation.

## Official-client capture fails or times out

Read the bounded diagnostic and immutable capture report when available. Common causes are resource-pack reload/model-bake errors, an invalid exact item stack, an altered proposal, unavailable OpenGL initialization, or a scene that never reached its required frame. Resolve the pack/client error before increasing the timeout. Cancellation and timeout terminate the client and remove the disposable game directory; a user save is never involved.

Do not attach full logs to a public issue without review. They can contain local paths, pack identifiers, graphics-driver details, or content from the staged project.

## Client screenshots differ between machines

This is expected across some GPU, driver, operating-system, OpenGL, resolution, FOV, and GUI-scale combinations. Required stock client frames have `authoritative_environment_capture` authority for the environment recorded in their report, not a cross-GPU pixel-determinism guarantee. Optional scale-reference frames remain `augmented_qa_reference` and non-WYSIWYG even though Minecraft rendered them. Compare proposal/client/mod hashes first; if those match, review the recorded environment fields before treating a pixel change as a regression. Use the CPU renderer's content hash for portable deterministic regression checks and the stock client frames for environment-specific visual evidence.

## `visual_commit` reports a stale proposal or hash

Do not retry with guessed hashes. Inspect the project/revision again and recreate `visual_connect` so the proposal captures the current destinations. Review the new files and `proposalSha256`, revalidate, and commit only after explicit acceptance. Any changed destination intentionally invalidates the old proposal.

For `held_item` or `gui_item`, production commit also requires `expectedClientCaptureReportSha256` equal to the current verified report returned by `visual_capture`. A new proposal, spec/revision, pack snapshot, client/mod, or recapture intentionally makes old evidence stale. `visual_validate` with `requireClientCapture: false` is advisory only and does not waive this commit precondition. Capture-unsupported profiles do not invent a report hash.

If Packwright returns `transaction_recovery_required`, stop automated writes and preserve `.packwright/transactions/<transaction-id>.json`. It means a commit failed and safe rollback could not be proven. Review that journal and the named destinations in source control before any manual recovery.

## Reporting a problem

Search [existing issues](https://github.com/rithwikbabu/packwright-mcp/issues) before filing a sanitized bug report. Do not attach the Minecraft jar, private datapacks, credentials, usernames, or full logs. Report vulnerabilities through [private vulnerability reporting](https://github.com/rithwikbabu/packwright-mcp/security/advisories/new).
