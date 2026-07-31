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

This caches the manifest-verified client jar and asset index, not all client asset objects. In v0.3 it reports setup/readiness only; compilation, rendering, and validation do not load a missing built-in model or texture from it.

## Java is missing or incompatible

Minecraft Java Edition 26.2 command validation, builds, and GameTests require Java 25. Set `PACKWRIGHT_JAVA` to the Java 25 executable when it is not first on `PATH`, then rerun `doctor`. Normal authoring and explicit structural-only validation do not need Java.

## A vanilla command diagnostic includes `Did you mean`

The command rejection and its source range come from Minecraft 26.2's real parser. The suggested replacement is Packwright's deterministic heuristic over identifiers in the verified cached registry/command reports; it is not a correction supplied or guaranteed by Minecraft. Review the proposed identifier and its intended semantics before editing the pack.

If a function macro receives a deferred informational diagnostic, Minecraft validated its macro template but could not parse the final substituted command without runtime arguments. Likewise, a clean parse does not establish that an objective, entity, storage value, or other required world state will exist. Exercise those cases with focused GameTests.

## A GameTest times out

Check the bounded stderr/log excerpt for pack load errors, a selector that never completes, or insufficient runner resources. Narrow the selected tests before raising the timeout. Packwright terminates the Java child and cleans its disposable universe on timeout or cancellation.

## A GameTest reports a missing test function

Do not point a function-type `test_instance` at a datapack `.mcfunction`. Vanilla resolves that field through its internal `test_function` registry, which datapacks cannot extend. Use a known vanilla Test Function only for smoke coverage, or use a `block_based` test with an existing binary structure containing Test Blocks.

## A build is refused

Run default `validate` and resolve both structural and vanilla command errors first. Also confirm Java 25 and the prepared 26.2 cache are available, check the 20,000-file/512-MiB scan limits and 20,000-logical-command probe limit, and confirm the output location is permitted. Build always runs vanilla command validation and cannot be forced past missing setup or an authoritative parse error. Warnings and informational macro findings alone do not block a build.

For `project_build`, both associated packs must have compatible metadata: datapack format `107.1` and resource-pack format `88.0`, and the project's one active workflow head must have ready textures and compiled artifacts and be rendered, bound, and committed. Packwright validates exact stable snapshots of both committed packs rather than a draft overlay, creates both ZIPs, and installs them in one transaction. With `overwrite: true`, supply both expected fields. Use the current SHA-256 for an output that exists and `null` for an output that is expected to be absent; Packwright does not accept only one precondition. A true `truncated` result means the bounded diagnostic list was shortened, not that either ZIP was partial.

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

The CPU preview is deterministic and approximate. It does not run the actual Minecraft client, and the current release does not provide real-client capture or full special-model rendering. A clean contact sheet therefore needs agent review and is not authoritative client-render evidence.

## `visual_commit` reports a stale proposal or hash

Do not retry with guessed hashes. Inspect the project/revision again and recreate `visual_connect` so the proposal captures the current destinations. Review the new files and `proposalSha256`, revalidate, and commit only after explicit acceptance. Any changed destination intentionally invalidates the old proposal.

If Packwright returns `transaction_recovery_required`, stop automated writes and preserve `.packwright/transactions/<transaction-id>.json`. It means a commit failed and safe rollback could not be proven. Review that journal and the named destinations in source control before any manual recovery.

## Reporting a problem

Search [existing issues](https://github.com/rithwikbabu/packwright-mcp/issues) before filing a sanitized bug report. Do not attach the Minecraft jar, private datapacks, credentials, usernames, or full logs. Report vulnerabilities through [private vulnerability reporting](https://github.com/rithwikbabu/packwright-mcp/security/advisories/new).
