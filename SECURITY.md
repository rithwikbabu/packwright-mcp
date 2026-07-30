# Security policy

Packwright operates on local files and can launch a downloaded Minecraft server jar for tests. Treat its workspace, cache, and subprocess boundaries as security-sensitive.

## Supported versions

| Version                   | Security fixes |
| ------------------------- | -------------- |
| 0.1.x                     | Supported      |
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
- Verify the downloaded jar against Mojang's version-manifest digest.
- Run GameTests only in a newly created disposable universe, never a user-provided world.
- Avoid forwarding arbitrary shell commands or JVM arguments.

These controls do not replace backups or source control. Anyone who can direct your MCP client may request writes within the configured workspace. Use a dedicated workspace, review tool approvals, enable `PACKWRIGHT_READ_ONLY=true` for analysis-only use, and keep valuable packs under version control.

More detail is available in [docs/security-model.md](docs/security-model.md).
