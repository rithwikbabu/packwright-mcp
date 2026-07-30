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
| yazl            | <https://github.com/thejoshwolfe/yazl>                   |

## Optional external Spyglass integration

Packwright can communicate with an operator-installed Spyglass language server over its public stdio LSP interface to obtain additional diagnostics. The adapter is compatibility-pinned to version `0.4.65`. Spyglass is not a Packwright dependency, is never downloaded or enabled automatically, and is not vendored into this repository. It retains its MIT License.

- Project: <https://github.com/SpyglassMC/Spyglass>
- Copyright: the Spyglass contributors

The current Spyglass release is excluded from Packwright's dependency tree because its transitive archive-extraction dependency has an unfixed critical Zip Slip advisory. Operators are responsible for reviewing and safely installing any external validator configured through `PACKWRIGHT_SPYGLASS_COMMAND`.

## Minecraft services and artifacts

Minecraft, Minecraft Java Edition, server jars, generated reports, registries, and other game data are not licensed under Packwright's MIT License and are not distributed with this project. When an operator explicitly runs `setup-version`, Packwright downloads an official server jar from Mojang and stores it only in the operator's local cache. Use of that artifact is subject to the [Minecraft EULA](https://www.minecraft.net/eula) and [Minecraft Usage Guidelines](https://www.minecraft.net/usage-guidelines).

Packwright does not vendor `misode/mcmeta`, Minecraft assets, generated vanilla data, or decompiled Minecraft sources.

> **NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.**
