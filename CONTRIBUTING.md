# Contributing to Packwright MCP

Thank you for helping improve Packwright. Contributions of code, tests, documentation, and well-scoped bug reports are welcome.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Security vulnerabilities must be reported through the private process in [SECURITY.md](SECURITY.md), not a public issue.

## Development setup

You need:

- Node.js 20 or newer and npm.
- Git.
- Java 25 only when working on vanilla setup or GameTest integration.

Fork and clone the repository, then create a focused branch:

```sh
git clone https://github.com/YOUR-USER/packwright-mcp.git
cd packwright-mcp
npm ci
npm run build
```

Run the local server against a disposable absolute workspace path:

```sh
node dist/cli.js serve --workspace /absolute/path/to/disposable/datapacks
```

Do not point a development build at an irreplaceable world or an uncommitted datapack.

## Before opening a pull request

Run the same checks as CI:

```sh
npm run lint
npm run format:check
npm run typecheck
npm test
npm audit --audit-level=high
npm run build
npm pack --dry-run
```

Add or update tests for behavior changes. Safety-sensitive changes should include negative tests for traversal, symlinks, stale hashes, size limits, subprocess cancellation, or other relevant failure modes.

Minecraft integration tests are not part of ordinary CI. Maintainers run the manually approved `Minecraft integration` workflow when a change affects Mojang downloads, Java discovery, vanilla validation, pack loading, or GameTest parsing. That workflow requires explicit EULA acceptance and never uploads the server jar.

## Design expectations

- Preserve the stdio boundary: JSON-RPC goes to stdout; logs and diagnostics go to stderr.
- Keep all datapack paths relative to the configured absolute workspace and route filesystem access through the confinement layer.
- Do not add arbitrary shell commands, JVM flags, user-world paths, or silent network access.
- Keep Minecraft-version behavior behind a version profile. Version-specific logic must not leak into stable MCP tool contracts.
- Return structured results and normalized diagnostics. Avoid unstructured exceptions for expected validation or setup failures.
- Do not vendor Minecraft artifacts, generated vanilla data, Mojang artwork, or decompiled sources.
- Keep public schemas strict and document any compatible interface change.

## Pull requests

Keep each pull request reviewable and describe:

1. The problem and intended behavior.
2. Safety or compatibility effects.
3. Tests performed, including whether the manual Minecraft suite is relevant.
4. User-facing documentation or changelog updates.

Maintainers may ask for a changeset to be split when unrelated behavior is bundled together. Commits do not need to be squashed before review.

Contributions are licensed under the repository's [MIT License](LICENSE).
