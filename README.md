# Packwright MCP

[![CI](https://github.com/rithwikbabu/packwright-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/rithwikbabu/packwright-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40rithwikbabu%2Fpackwright-mcp)](https://www.npmjs.com/package/@rithwikbabu/packwright-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Packwright MCP is a local-first [Model Context Protocol](https://modelcontextprotocol.io/) server for safely creating, inspecting, validating, testing, and packaging Minecraft Java Edition datapacks. It gives an MCP client structured tools instead of unrestricted filesystem or shell access.

> **NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.**

Packwright does not contain or redistribute Minecraft code, assets, server jars, generated vanilla data, or decompiled sources.

## Status and compatibility

Packwright `0.1.x` supports [Minecraft Java Edition **26.2**](https://www.minecraft.net/en-us/article/minecraft-java-edition-26-2) only, datapack format **107.1**. Node.js 20 or newer is required. Java 25 is needed only for `setup-version` and authoritative vanilla GameTest runs; normal authoring and structural validation do not require Java.

The server uses the stable MCP TypeScript SDK v2, targets the MCP `2026-07-28` specification, and relies on SDK protocol negotiation for compatible clients.

The server is local and stdio-only. It does not install packs into a live world, expose an HTTP endpoint, support Bedrock behavior packs, or create resource packs.

## What it provides

- Guarded datapack creation and resource editing with atomic writes and SHA-256 preconditions.
- Datapack inspection, resource lookup, and cached Minecraft command/registry search.
- Always-available structural validation, plus optional diagnostics from an operator-configured external Spyglass process.
- Disposable vanilla pack-loading and GameTest execution after explicit setup.
- Deterministic ZIP builds that fail when structural validation has errors.
- Read-only MCP resources and workflow prompts for review, scaffolding, and GameTest authoring.

See [MCP tools, resources, and prompts](docs/mcp-reference.md) for the complete interface.

## Install and connect

Choose an existing directory that will contain the datapack projects Packwright may access. It must be an absolute path.

Generic MCP client configuration:

```json
{
  "mcpServers": {
    "packwright": {
      "command": "npx",
      "args": [
        "-y",
        "@rithwikbabu/packwright-mcp@0.1.2",
        "serve",
        "--workspace",
        "/absolute/path/to/datapacks"
      ]
    }
  }
}
```

The workspace can instead be passed through the environment:

```json
{
  "mcpServers": {
    "packwright": {
      "command": "npx",
      "args": ["-y", "@rithwikbabu/packwright-mcp@0.1.2"],
      "env": {
        "PACKWRIGHT_WORKSPACE": "/absolute/path/to/datapacks"
      }
    }
  }
}
```

Using an exact package version is recommended for predictable automation. The server writes protocol messages only to stdout and sends logs to stderr.

## CLI

The installed `packwright-mcp` binary defaults to `serve` when no subcommand is supplied:

```text
packwright-mcp serve --workspace /absolute/path/to/datapacks
packwright-mcp doctor --workspace /absolute/path/to/datapacks
packwright-mcp setup-version 26.2 --accept-minecraft-eula --workspace /absolute/path/to/datapacks
packwright-mcp validate <pack> --workspace /absolute/path/to/datapacks
packwright-mcp test <pack> --workspace /absolute/path/to/datapacks
packwright-mcp build <pack> --workspace /absolute/path/to/datapacks
```

Use `--json` with `doctor`, `setup-version`, `validate`, `test`, or `build` for machine-readable output. Run `packwright-mcp <command> --help` for command-specific options. See the [CLI reference](docs/cli-reference.md) and [Configuration](docs/configuration.md) for all flags, precedence, environment variables, and exit behavior.

## Vanilla setup and testing

`setup-version` is an explicit operator action. It records acceptance of the Minecraft EULA, obtains the official 26.2 server jar from Mojang, verifies the SHA-1 declared by Mojang's version manifest, and prepares local validation data. The MCP server never downloads the jar or accepts terms on a model's behalf.

```sh
packwright-mcp setup-version 26.2 \
  --accept-minecraft-eula \
  --workspace /absolute/path/to/datapacks
```

Authoritative tests run `net.minecraft.gametest.Main` with Java 25 in a newly created disposable universe. A user world path is never accepted as the test universe. See [Validation and vanilla testing](docs/validation-and-testing.md).

Function-type GameTests resolve Minecraft's internal `test_function` registry; a datapack `.mcfunction` does not register a Test Function. Use `minecraft:always_pass` only for pack-load/runner smoke coverage, or an existing block-based test structure for behavior-focused tests.

Spyglass is deliberately not installed as a runtime dependency. The adapter is compatibility-pinned to Spyglass `0.4.65` and verifies the configured executable's `--version` output before use. An operator who has independently installed and reviewed a safe build may opt in with `PACKWRIGHT_SPYGLASS_COMMAND`; Packwright never downloads or enables it automatically.

## Safety model

Packwright resolves every requested path beneath the configured workspace, rejects traversal and symlink escapes, limits scans and payloads, and never recursively deletes directories. Existing files can be replaced or deleted only with explicit intent and the current SHA-256. Raw authoring is limited to supported datapack text formats; binary NBT and `pack.png` may be inspected and packaged but not authored.

Read [Security model](docs/security-model.md) before granting the server access to valuable projects. Consider source control and `PACKWRIGHT_READ_ONLY=true` for review-only sessions.

For common startup, cache, Java, validation, and build failures, see [Troubleshooting](docs/troubleshooting.md). Maintainers and contributors can find the component boundaries in [Architecture](docs/architecture.md).

## Development

```sh
npm ci
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

Minecraft integration tests are intentionally separate because they download Mojang's server jar and require Java 25 plus explicit EULA acceptance. Contribution setup and test expectations are in [CONTRIBUTING.md](CONTRIBUTING.md).

## License and trademarks

Packwright MCP is available under the [MIT License](LICENSE). External software and service terms are summarized in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Minecraft is a trademark of Microsoft Corporation. This project follows the [Minecraft Usage Guidelines](https://www.minecraft.net/usage-guidelines) and uses no Mojang or Microsoft artwork.
