# Maintainer release guide

Packwright keeps the npm package, `package.json.mcpName`, `server.json`, Git tag, MCP Registry entry, changelog, and GitHub release aligned.

## One-time repository setup

1. Publish the GitHub repository as `rithwikbabu/packwright-mcp` with `main` as the default branch.
2. Require the `Node 20`, `Node 22`, `Node 24`, and `Package dry run` checks on `main`, and enable private vulnerability reporting.
3. Create protected GitHub environments named `release` and `minecraft-integration`. Add a required reviewer when a second maintainer is available; a sole maintainer must not configure a rule that makes approval impossible. Disable self-review where repository policy and the maintainer roster support it.
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
3. Run all ordinary checks and the protected Minecraft integration workflow.
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

Release and ordinary CI jobs must never download the Minecraft server jar. Only the manually approved integration workflow may run setup, and no workflow may upload the jar, generated registries, decompiled sources, or other Minecraft artifacts.
