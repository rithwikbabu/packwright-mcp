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

## Reporting a problem

Search [existing issues](https://github.com/rithwikbabu/packwright-mcp/issues) before filing a sanitized bug report. Do not attach the Minecraft jar, private datapacks, credentials, usernames, or full logs. Report vulnerabilities through [private vulnerability reporting](https://github.com/rithwikbabu/packwright-mcp/security/advisories/new).
