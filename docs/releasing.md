# Maintainer release guide

Packwright keeps the npm package, `package.json.mcpName`, `server.json`, Git tag, MCP Registry entry, changelog, and GitHub release aligned.

## One-time repository setup

1. Publish the GitHub repository as `rithwikbabu/packwright-mcp` with `main` as the default branch.
2. Require the `Node 20`, `Node 22`, `Node 24`, and `Package dry run` checks on `main`, and enable private vulnerability reporting.
3. Create protected GitHub environments named `release`, `minecraft-integration`, and `minecraft-client-capture`. Add a required reviewer when a second maintainer is available; a sole maintainer must not configure a rule that makes approval impossible. Disable self-review where repository policy and the maintainer roster support it. The client-capture gate runs only on a trusted interactive macOS host, not a generic hosted runner.
4. Verify the npm package name is `@rithwikbabu/packwright-mcp` and the MCP name is `io.github.rithwikbabu/packwright-mcp`.

## Bootstrap npm 0.1.0

npm requires a package to exist before a trusted publisher can be attached. Bootstrap the first public version from a clean, reviewed `main` checkout:

```sh
npm ci
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build
npm pack --dry-run
npm login
npm publish --access public
```

Confirm that `0.1.0` is visible at <https://www.npmjs.com/package/@rithwikbabu/packwright-mcp> before tagging.

In the npm package settings, add a GitHub Actions trusted publisher with:

| Setting              | Value            |
| -------------------- | ---------------- |
| Organization or user | `rithwikbabu`    |
| Repository           | `packwright-mcp` |
| Workflow filename    | `release.yml`    |
| Environment          | `release`        |
| Allowed action       | `npm publish`    |

Trusted publishing requires a GitHub-hosted runner, `id-token: write`, Node 22.14 or newer, and npm 11.5.1 or newer. After verifying OIDC publication, configure npm to require 2FA and disallow token-based publishing, then revoke obsolete automation tokens.

## Release checklist

1. Update `CHANGELOG.md` and all version-bearing metadata. `package.json`, the top-level `server.json.version`, and `server.json.packages[0].version` must match exactly.
2. Confirm `package.json.mcpName` equals `server.json.name`.
3. Run all ordinary checks and the protected Minecraft server integration workflow. For a release that changes client launch, capture protocol, scene lowering, capture-mod code, or visual evidence verification, also complete the protected manual macOS client-capture gate below.
4. Merge the release change to `main`, then create an annotated `vX.Y.Z` tag on that commit and push it. Sign the tag when the maintainer has a verified signing key configured.
5. Approve the `release` environment deployment after inspecting the tag and CI result.
6. Verify npm, the MCP Registry, and the generated GitHub release.

The release workflow first verifies that the tagged commit is on `main`, runs all ordinary gates without write or OIDC permissions, and uploads the resulting tarball. Only the protected publish job receives that verified tarball and OIDC credentials. It uses npm trusted publishing with automatic provenance, then authenticates `mcp-publisher` through GitHub OIDC. It downloads a pinned publisher archive with GitHub CLI, verifies its committed SHA-256, and extracts it locally; it never pipes a network response into a shell.

The workflow tolerates a package version that is already public only when its npm SHA-512 integrity exactly matches the verified release tarball, so the manually bootstrapped `0.1.0` can proceed to MCP Registry and GitHub release creation safely. It also reconfirms the release tag's commit after environment approval and immediately before creating the GitHub release. Never move or reuse a version tag for different contents.

If a workflow defect prevents publication after an immutable tag has been created, do not delete, move, or manually republish that tag. Fix the workflow, increment every package/server version, and create a new patch release through the normal tag-triggered path. This keeps npm provenance tied to the exact source commit that owns the published version.

## MCP Registry bootstrap and verification

The tag workflow publishes `server.json` automatically after the npm version is visible. If an initial manual registry publish is required, install the official `mcp-publisher` from a verified release, then run:

```sh
mcp-publisher login github
mcp-publisher publish
```

GitHub authentication must use the `rithwikbabu` account because the server name is under `io.github.rithwikbabu`. Verify publication:

```text
https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.rithwikbabu/packwright-mcp
```

The MCP Registry is a metadata registry and may remain in preview. Re-check its schema and publisher release before changing the pinned publisher version or `server.json` schema URL.

## Minecraft artifact policy

Release and ordinary CI jobs must never download Minecraft jars, assets, libraries, natives, or generated vanilla data. Only a manually approved integration workflow or local release gate may run setup, and no workflow may upload the cache, jars, assets, generated registries, decompiled sources, full logs, or framebuffer captures.

The npm package includes one original Packwright artifact at `capture-mod/runtime/packwright-capture-mod-0.4.1.jar`. It is built from the MIT-licensed source under `capture-mod/` and must not contain Minecraft classes/assets, Fabric Loader, Fabric API, ASM, Sponge Mixin, or other downloaded launcher components. `package.json.files` allow-lists only that exact runtime JAR plus its Packwright license/readme. Before changing it, a maintainer must:

1. Accept the Minecraft EULA and build the capture-mod source in an isolated local environment with Java 25 and the pinned Gradle/Loom configuration.
2. Run the capture-mod unit tests and inspect the resulting JAR entry list for only Packwright classes/resources and normal JAR metadata.
3. Copy the reproducible non-sources JAR to the exact `capture-mod/runtime/` path, verify a clean rebuild has the same SHA-256, and review the binary-size/content diff.
4. Run `npm pack --dry-run` and inspect the tarball list: the Packwright JAR may be present; no file from a Gradle cache, Minecraft/Fabric download cache, game directory, client asset tree, or captured output may be present.

## Official-client graphical release gate

Current capture uses a real OpenGL window and is intentionally not claimed by hosted CI. On a protected trusted interactive macOS machine, use an isolated absolute workspace/cache and Java 25, explicitly accept the EULA, and run `setup-version 26.2 --client-capture`. Capture both the known `held_item` and `gui_item` fixtures from their exact connected proposals with the default settings. Confirm that every required `first_person_vanilla` view uses exact stock gameplay composition with no injected reference arm, then run the held-item capture again with `--include-scale-reference-views`. Confirm the supplemental `first_person_scale_reference` frames appear only in the separate QA sheet, are clearly non-WYSIWYG, and cannot replace required authority. Run `visual_validate` with its default capture-required policy, and prove `visual_commit` accepts only each exact `expectedClientCaptureReportSha256`.

The repository acceptance harness can exercise one complete held-item vertical slice with the actual client:

```sh
PACKWRIGHT_CACHE_DIR=/absolute/path/to/disposable/cache \
PACKWRIGHT_ACCEPT_MINECRAFT_EULA=true \
PACKWRIGHT_RUN_CLIENT_CAPTURE=true \
npm run test:minecraft
```

Review that each result binds the expected client/mod/pack/item hashes, includes the complete required scene set, records the OS/Java/GPU/driver/OpenGL/settings environment, and has a clean resource-load log. Required stock views must report `authoritative_environment_capture`; optional scale references must report `augmented_qa_reference` and remain supplemental. Confirm timeout/cancellation cleanup and that no user save or unrelated mod was touched. Authoritative pixels are release evidence for that recorded environment, not a cross-GPU golden image.

Destroy the isolated game/cache state when review is complete. Do not upload Mojang artifacts, full logs, or framebuffer evidence to GitHub Actions. A future self-hosted graphical harness may automate this protected gate; until then, record only a sanitized pass/fail attestation in the release checklist.
