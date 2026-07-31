# Packwright MCP

[![CI](https://github.com/rithwikbabu/packwright-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/rithwikbabu/packwright-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40rithwikbabu%2Fpackwright-mcp)](https://www.npmjs.com/package/@rithwikbabu/packwright-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Packwright MCP is a local-first [Model Context Protocol](https://modelcontextprotocol.io/) server for safely creating, inspecting, validating, testing, and packaging Minecraft Java Edition datapacks and paired resource packs. It gives an MCP client structured tools instead of unrestricted filesystem or shell access.

> **NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.**

Packwright does not contain or redistribute Minecraft code, assets, server/client jars, libraries, natives, generated vanilla data, or decompiled sources. The npm package includes only Packwright's original MIT-licensed capture mod.

## Status and compatibility

Packwright supports [Minecraft Java Edition **26.2**](https://www.minecraft.net/en-us/article/minecraft-java-edition-26-2) only: datapack format **107.1** and resource-pack format **88.0**. Node.js 20 or newer is required. Default validation, every datapack or paired-project build, vanilla GameTest runs, and official-client visual capture require Java 25 plus the corresponding operator-prepared Minecraft 26.2 cache. Normal authoring, CPU visual drafting/rendering, and an explicitly requested advisory/structural-only validation do not require Java.

The server uses the stable MCP TypeScript SDK v2, targets the MCP `2026-07-28` specification, and relies on SDK protocol negotiation for compatible clients.

The server is local and stdio-only. It does not install packs into a live world, expose an HTTP endpoint, or support Bedrock behavior packs.

## What it provides

- Guarded datapack creation and resource editing with atomic writes and SHA-256 preconditions.
- Datapack inspection, resource lookup, and cached Minecraft command/registry search.
- Default vanilla-backed validation of every `.mcfunction` command with Minecraft 26.2's real dispatcher, registries, and component codecs.
- Always-available structural validation, plus optional diagnostics from an operator-configured external Spyglass process.
- Disposable vanilla pack-loading and GameTest execution after explicit setup.
- Deterministic ZIP builds that fail when structural or vanilla command validation has errors.
- Paired datapack/resource-pack projects with truthful Minecraft `native`, `simulated`, `replacement`, and `requires_mod` profiles plus a separate `compilerSupport` implementation status.
- A semantic custom-item model DSL, `minecraft:item_model` bindings, safe PNG import, profile-specific deterministic CPU previews, immutable repair revisions, and guarded multi-file commit.
- Eight model-specific visual review profiles: `held_item`, `block`, `placeable`, `armor`, `head_wearable`, `projectile`, `gui_item`, and `entity_model`, each with deterministic scenes, Packwright-authored reference geometry, advisory measurements, and an immutable render report.
- Explicitly prepared, hash-bound framebuffer capture through the actual Minecraft 26.2 client renderer: `held_item` is `limited` to one-handed scenes in v0.4, while `gui_item` is `full`. The official client runs in a disposable game directory with only Packwright's capture mod; the CPU renderer remains the fast deterministic first gate.
- Validation of the exact uncommitted proposal over stable datapack/resource-pack snapshots, followed by transactional deterministic ZIPs from the exact committed pack snapshots.
- Read-only MCP resources and workflow prompts for review, scaffolding, and GameTest authoring.

The v0.4 visual compiler is intentionally narrower than the Minecraft capability matrix: `compilerSupport` is `full` for `custom_item`, `limited` for `conditional_item_state`, and `unsupported` for every other target. The automatic vertical slice still compiles custom items only, including a constrained conditional state DSL, and keeps one active visual head per paired project. Selecting one of the eight review profiles changes only its review scenes and measurements; it does not change Minecraft output, add block/equipment/entity compilation, or imply native support for the pictured target. Official-client capture support is separately reported as `limited` for `held_item`, `full` for `gui_item`, and `unsupported` for the other six profiles; two-handed held-item capture is rejected until the client adapter can pose and verify a secondary Minecraft-rendered arm at `secondaryGrip`. Packwright fails explicitly instead of substituting CPU images. Blocks, equipment, paintings/trims, mob variants, display rigs, animations, GUIs, generator adapters, and multi-asset project heads remain later phases. See the [paired visual compiler guide](docs/visual-compiler.md) and [MCP tools, resources, and prompts](docs/mcp-reference.md).

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
        "@rithwikbabu/packwright-mcp@0.4.0",
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
      "args": ["-y", "@rithwikbabu/packwright-mcp@0.4.0"],
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
packwright-mcp setup-version 26.2 --accept-minecraft-eula --client-assets --workspace /absolute/path/to/datapacks
packwright-mcp setup-version 26.2 --accept-minecraft-eula --client-capture --workspace /absolute/path/to/datapacks
packwright-mcp capture <project-id> --run <sha256> --proposal-sha256 <sha256> --confirm --workspace /absolute/path/to/datapacks
packwright-mcp validate <pack> --workspace /absolute/path/to/datapacks
packwright-mcp test <pack> --workspace /absolute/path/to/datapacks
packwright-mcp build <pack> --workspace /absolute/path/to/datapacks
```

Use `--json` with `doctor`, `setup-version`, `capture`, `validate`, `test`, or `build` for machine-readable output. Run `packwright-mcp <command> --help` for command-specific options. See the [CLI reference](docs/cli-reference.md) and [Configuration](docs/configuration.md) for all flags, precedence, environment variables, and exit behavior.

## Vanilla setup and testing

`setup-version` is an explicit operator action. It records acceptance of the Minecraft EULA, obtains the official 26.2 server jar from Mojang, verifies the SHA-1 declared by Mojang's version manifest, and prepares local validation data. The MCP server never downloads the jar or accepts terms on a model's behalf.

```sh
packwright-mcp setup-version 26.2 \
  --accept-minecraft-eula \
  --workspace /absolute/path/to/datapacks
```

Add `--client-assets` only to prepare the official client jar and asset-index readiness metadata used by asset-aware tooling. Add `--client-capture` to prepare the complete platform-specific launcher runtime, every indexed asset object, required libraries and natives, and pinned Fabric Loader `0.19.3`; it implies the client-assets step. Every downloaded artifact is allow-listed and checked against the Mojang or Packwright-pinned digest. Minecraft client artifacts remain only in the local cache and are never copied into the workspace, npm package, or release artifacts. Semantic compilation still requires custom external textures/models to exist at their normal paths in the paired resource pack; it does not copy them from the client cache.

`visual_capture` is a separate, explicitly confirmed MCP operation. It requires Java 25, the completed `--client-capture` setup, and an interactive macOS graphical session capable of creating a real OpenGL window. Packwright stages the exact datapack/resource-pack proposal in a fresh disposable game directory, launches the official client in offline developer mode with multiplayer and chat disabled, loads only Packwright's bundled capture mod, captures through Minecraft's screenshot API, and deletes the disposable game directory afterward. First-person visible-arm scenes sign both `referenceArm: true` and `referenceArmPurpose: "scale_only"`: Minecraft renders that review-only augmentation through its own item-in-hand renderer for scale and occlusion context, but it is explicitly not the stock 26.2 composition, does not claim palm-to-`primaryGrip` alignment, and never enters pack output. Grip distance remains a CPU advisory measurement, while the client frame requires human/agent visual review. Packwright never accepts an account credential or a user save path and never falls back to CPU output.

For supported one-handed `held_item` proposals and all `gui_item` proposals, production `visual_validate` requires current official-client evidence by default and `visual_commit` requires the exact verified capture-report SHA-256. A two-handed held-item proposal is rejected rather than receiving incomplete client authority. Pass `requireClientCapture: false` only for an explicitly advisory/fast validation; it does not make a supported-profile proposal committable. Profiles whose client implementation is truthfully `unsupported` keep their CPU-only path.

Client frames have `authoritative_environment_capture` authority: they prove what the pinned client rendered for the recorded operating system, Java runtime, GPU, driver, OpenGL backend, settings, pack hashes, item stack, and mod version. Hardware and drivers can legitimately change pixels, so these screenshots are not promised to be byte-identical across GPUs or operating systems. A `passed` capture means the planned evidence completed and verified; it is not aesthetic approval. The deterministic CPU report remains the portable advisory first gate, and a human/agent must review both evidence types.

After setup, `validate` uses the pinned vanilla runtime by default to parse each logical `.mcfunction` command against Minecraft 26.2's real command dispatcher, loaded datapack registries, and component codecs. This catches invalid command, selector, item/component, particle, attribute, entity, and text-component syntax before packaging. `validate --no-vanilla` is the explicit structural-only escape hatch; builds never provide that bypass.

Both command validation and authoritative tests run Java 25 in newly created disposable state. Command validation substitutes inert placeholders for the pack's functions and validates unreferenced command probes, so it does not execute user functions. GameTests receive a freshly allocated universe; a user world path is never accepted. See [Validation and vanilla testing](docs/validation-and-testing.md).

Function-type GameTests resolve Minecraft's internal `test_function` registry; a datapack `.mcfunction` does not register a Test Function. Use `minecraft:always_pass` only for pack-load/runner smoke coverage, or an existing block-based test structure for behavior-focused tests.

Spyglass is deliberately not installed as a runtime dependency. The adapter is compatibility-pinned to Spyglass `0.4.65` and verifies the configured executable's `--version` output before use. An operator who has independently installed and reviewed a safe build may opt in with `PACKWRIGHT_SPYGLASS_COMMAND`; Packwright never downloads or enables it automatically.

## Safety model

Packwright resolves every requested path beneath the configured workspace, rejects traversal and symlink escapes, limits scans and payloads, and never recursively deletes directories. Existing files can be replaced or deleted only with explicit intent and the current SHA-256. Raw authoring is limited to supported datapack text formats; binary NBT and `pack.png` may be inspected and packaged but not authored. Visual textures use a dedicated bounded PNG decoder, and accepted cross-pack proposals commit through a journaled transaction with all destination hashes checked first.

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

Minecraft integration tests are intentionally separate because they download Mojang artifacts and require Java 25 plus explicit EULA acceptance. The official-client capture release gate additionally requires a protected, interactive macOS machine; ordinary CI does not download or launch the client. Contribution setup and test expectations are in [CONTRIBUTING.md](CONTRIBUTING.md).

## License and trademarks

Packwright MCP is available under the [MIT License](LICENSE). External software and service terms are summarized in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Minecraft is a trademark of Microsoft Corporation. This project follows the [Minecraft Usage Guidelines](https://www.minecraft.net/usage-guidelines) and uses no Mojang or Microsoft artwork.
