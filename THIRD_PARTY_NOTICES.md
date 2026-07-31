# Third-party notices

Packwright MCP's source code is licensed under the MIT License. Its npm dependencies retain their own licenses; the installed package metadata and lockfile are the authoritative dependency inventory.

## Model Context Protocol TypeScript SDK

Packwright uses the official Model Context Protocol TypeScript SDK, distributed under the MIT License.

- Project: <https://github.com/modelcontextprotocol/typescript-sdk>
- Copyright: the Model Context Protocol contributors

## Zod

Packwright uses Zod for runtime schema validation, distributed under the MIT License.

- Project: <https://github.com/colinhacks/zod>
- Copyright: Colin McDonnell and contributors

## Other direct runtime dependencies

The following direct dependencies are distributed under the MIT License:

| Package         | Project                                                  |
| --------------- | -------------------------------------------------------- |
| Commander.js    | <https://github.com/tj/commander.js>                     |
| env-paths       | <https://github.com/sindresorhus/env-paths>              |
| fast-xml-parser | <https://github.com/NaturalIntelligence/fast-xml-parser> |
| yauzl           | <https://github.com/thejoshwolfe/yauzl>                  |
| yazl            | <https://github.com/thejoshwolfe/yazl>                   |

## Official-client capture dependencies

Packwright includes its own MIT-licensed client-only capture mod. The mod JAR contains Packwright code and metadata; it does not contain Minecraft classes, assets, Fabric Loader, Fabric API, or the libraries listed below.

When an operator explicitly selects client-capture setup, Packwright downloads and verifies these independently distributed launcher components for the local cache:

| Component                   | License      | Project                                     |
| --------------------------- | ------------ | ------------------------------------------- |
| Fabric Loader `0.19.3`      | Apache-2.0   | <https://github.com/FabricMC/fabric-loader> |
| ASM `9.10.1` modules        | BSD-3-Clause | <https://asm.ow2.io/>                       |
| SpongePowered Mixin `0.8.7` | MIT          | <https://github.com/SpongePowered/Mixin>    |

Fabric Loader and its libraries are neither npm dependencies nor redistributed in Packwright's package. Their upstream license files and metadata remain authoritative. Packwright does not depend on or bundle Fabric API.

The capture-mod source project also uses build-only tooling that is not included in the runtime JAR:

| Component              | License    | Project                                   |
| ---------------------- | ---------- | ----------------------------------------- |
| Gradle Wrapper `9.5.1` | Apache-2.0 | <https://github.com/gradle/gradle>        |
| Fabric Loom `1.17.17`  | MIT        | <https://github.com/FabricMC/fabric-loom> |

## Optional external Spyglass integration

Packwright can communicate with an operator-installed Spyglass language server over its public stdio LSP interface to obtain additional diagnostics. The adapter is compatibility-pinned to version `0.4.65`. Spyglass is not a Packwright dependency, is never downloaded or enabled automatically, and is not vendored into this repository. It retains its MIT License.

- Project: <https://github.com/SpyglassMC/Spyglass>
- Copyright: the Spyglass contributors

The current Spyglass release is excluded from Packwright's dependency tree because its transitive archive-extraction dependency has an unfixed critical Zip Slip advisory. Operators are responsible for reviewing and safely installing any external validator configured through `PACKWRIGHT_SPYGLASS_COMMAND`.

## Minecraft services and artifacts

Minecraft, Minecraft Java Edition, server/client jars, libraries, native libraries, assets, generated reports, registries, logs, screenshots, and other game data are not licensed under Packwright's MIT License and are not distributed with this project. When an operator explicitly runs `setup-version`, Packwright downloads the selected official Mojang artifacts and stores them only in the operator's local cache. Client-capture setup also obtains the complete pinned 26.2 launcher runtime needed by the current platform. Use of those artifacts is subject to the [Minecraft EULA](https://www.minecraft.net/eula) and [Minecraft Usage Guidelines](https://www.minecraft.net/usage-guidelines).

Packwright does not vendor `misode/mcmeta`, Minecraft jars or assets, generated vanilla data, or decompiled Minecraft sources. Client screenshots and bounded logs are user-generated evidence held in the local Packwright cache and are never release artifacts.

> **NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.**
