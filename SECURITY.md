# Security policy

Packwright operates on local files and can launch downloaded Minecraft server and client jars for validation, tests, and explicitly requested visual capture. Treat its workspace, cache, graphical client, and subprocess boundaries as security-sensitive.

## Supported versions

| Version                   | Security fixes |
| ------------------------- | -------------- |
| 0.4.x                     | Supported      |
| 0.3.x and earlier         | Not supported  |
| Earlier/unreleased builds | Not supported  |

Only the latest published patch release receives security fixes.

## Reporting a vulnerability

Do not open a public issue. Use GitHub's private vulnerability reporting for this repository:

<https://github.com/rithwikbabu/packwright-mcp/security/advisories/new>

Include the affected version, operating system, reproduction steps, expected impact, and any suggested mitigation. Remove credentials, private datapacks, Minecraft logs containing personal data, and proprietary content before attaching evidence.

You should receive an acknowledgement within seven days. The maintainer will coordinate validation, remediation, disclosure timing, and credit with the reporter. Please allow a reasonable remediation window before public disclosure.

## Security boundaries

Packwright promises to:

- Confine resolved paths to one configured absolute workspace and reject traversal or symlink escapes.
- Avoid recursive deletion and require an exact hash plus confirmation for destructive changes.
- Restrict model-authored files to supported datapack text formats.
- Keep network access out of MCP tool calls; only an operator-invoked setup command downloads Minecraft artifacts.
- Verify downloaded Mojang artifacts against manifest digests and pinned Fabric capture-runtime libraries against both SHA-1 and SHA-256 where available.
- Run GameTests only in a newly created disposable universe, never a user-provided world.
- Run official-client capture only in a newly created disposable game directory, load no mod except the bundled Packwright capture mod, and never accept account credentials or a user-provided save path.
- Disable multiplayer and chat in the capture client and expose a strict capture-plan protocol rather than arbitrary Minecraft commands, shell input, or JVM arguments.
- Avoid forwarding arbitrary shell commands or JVM arguments.

These controls do not replace backups or source control. Anyone who can direct your MCP client may request writes within the configured workspace or, when client capture is already prepared, request an expensive local graphical launch. `visual_capture` therefore requires `confirm: true`, production commit requires the exact verified capture-report hash for supported profiles, and client-capture setup remains a separate human CLI operation. Use a dedicated workspace, review tool approvals, enable `PACKWRIGHT_READ_ONLY=true` for analysis-only use, and keep valuable packs under version control. Treat the cache as sensitive: it can contain Minecraft artifacts, creative inputs, proposed pack contents, framebuffer screenshots, environment metadata, and bounded client logs.

More detail is available in [docs/security-model.md](docs/security-model.md).
