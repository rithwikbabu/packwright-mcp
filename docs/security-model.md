# Security model

Packwright is designed to give an MCP client narrow datapack capabilities inside one local directory. It is not a general-purpose filesystem or process-execution server.

## Trust boundaries

```text
MCP client
   | strict tool schemas
   v
Packwright process ----> configured workspace
   |                       (only confined pack paths)
   +----> local cache
   |      (verified 26.2 artifacts)
   +----> disposable Java 25 subprocess
          (fresh test universe only)
```

The operator trusts the local Packwright process and chooses the workspace. MCP input, datapack content, symlinks, downloaded metadata, validator output, and Minecraft subprocess output are treated as untrusted.

## Filesystem confinement

Before access, Packwright rejects absolute request paths and traversal, decodes and normalizes input, resolves existing ancestors, checks symlink targets, and verifies the canonical target remains under the canonical workspace. Resource operations additionally require a detected pack root.

Confinement is rechecked at write time to reduce time-of-check/time-of-use exposure. Writes use a same-directory temporary file and atomic rename. A per-path lock serializes concurrent mutations.

Creating a new file is allowed by default. Replacing an existing file requires `overwrite: true` and its current SHA-256. Deletion requires an exact file, `confirm: true`, and its current SHA-256. Directories are never recursively deleted.

These safeguards prevent accidental broad changes and stale writes; they do not defend against a malicious local account that can concurrently replace directories or modify the Packwright executable.

## Content and capacity limits

Model-authored raw files are restricted to supported datapack text extensions. Binary NBT and `pack.png` can be inventoried, hashed, copied, and packaged, but not created or edited through content tools.

Scans/builds stop at 20,000 files or 512 MiB, writes stop at 4 MiB, and MCP payloads stop at 1 MiB. Packwright reports truncation rather than silently presenting shortened content as complete.

## Network and external processes

MCP tools do not make network requests. `setup-version` is a separate human-invoked CLI operation; it requires explicit EULA acceptance and verifies the official jar against Mojang's manifest digest. Offline mode forbids even that setup request.

Vanilla tests use a fixed entrypoint and Packwright-controlled arguments. Callers cannot supply shell fragments, arbitrary JVM flags, or a universe path. The subprocess has a timeout, honors MCP cancellation, and writes only to allocated temporary paths and reports.

An optional operator-installed Spyglass process is isolated behind its stdio LSP protocol. It is disabled unless `PACKWRIGHT_SPYGLASS_COMMAND` is configured outside MCP input; its diagnostics are bounded and normalized before being returned to a client.

## Operator guidance

- Use a dedicated workspace containing only datapacks the client should access.
- Keep packs in source control and review diffs before running them in Minecraft.
- Use `PACKWRIGHT_READ_ONLY=true` for review-only tasks.
- Pin the npm package version in MCP client configuration.
- Run `doctor` after Java, cache, or permission changes.
- Do not expose the stdio process through an unauthenticated remote bridge.
- Review Minecraft logs before sharing them; they can contain usernames, paths, or pack content.

Report suspected vulnerabilities through the private channel in [SECURITY.md](../SECURITY.md).
