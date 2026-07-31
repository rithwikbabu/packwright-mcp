# Security model

Packwright is designed to give an MCP client narrow datapack and paired resource-pack capabilities inside one local directory. It is not a general-purpose filesystem, binary-writing, image-generation, or process-execution server.

## Trust boundaries

```text
MCP client
   | strict tool schemas
   v
Packwright process ----> configured workspace
   |                       (only confined pack/project paths)
   +----> local cache
   |      (verified 26.2 artifacts and immutable visual runs)
   +----> disposable Java 25 subprocess
          (fresh test universe only)
```

The operator trusts the local Packwright process and chooses the workspace. MCP input, datapack/resource-pack content, imported PNGs, visual provenance, symlinks, downloaded metadata, validator output, and Minecraft subprocess output are treated as untrusted.

## Filesystem confinement

Before access, Packwright rejects absolute request paths and traversal, decodes and normalizes input, resolves existing ancestors, checks symlink targets, and verifies the canonical target remains under the canonical workspace. Resource operations additionally require a detected pack root. A visual project manifest can associate only distinct sibling datapack/resource-pack directories and is itself confined to `.packwright/projects/`.

Confinement is rechecked at write time to reduce time-of-check/time-of-use exposure. Writes use a same-directory temporary file and atomic rename. A per-path lock serializes concurrent mutations.

Creating a new file is allowed by default. Replacing an existing file requires `overwrite: true` and its current SHA-256. Deletion requires an exact file, `confirm: true`, and its current SHA-256. Directories are never recursively deleted.

These safeguards prevent accidental broad changes and stale writes; they do not defend against a malicious local account that can concurrently replace directories or modify the Packwright executable.

## Cross-pack transactions

`visual_connect` is proposal-only. It hashes the exact generated content and captures the current SHA-256—or expected absence—of every destination in both packs. `visual_commit` requires explicit confirmation and that proposal's exact content ID.

Before installation, Packwright resolves all destinations, rejects duplicates, verifies the complete precondition set, locks paths in deterministic sorted order, and stages each file beside its destination. A journal under `.packwright/transactions/` records the operation before any destination changes. Installation uses atomic filesystem operations and attempts rollback after a partial failure. If safe rollback cannot be proven, Packwright retains the journal and returns `transaction_recovery_required` rather than silently claiming success. `visual_commit` installs a canonical receipt under `.packwright/visual-commits/` in the same transaction as its generated files. If the cache-state write is interrupted afterward, a retry verifies that receipt and every installed proposal hash before reporting the original content-addressed transaction ID.

One visual transaction is limited to 512 files and 64 MiB. There is no recursive operation and no force option that bypasses a stale hash. `project_build` separately validates exact committed snapshots and installs the datapack and resource-pack ZIPs together through the same transaction mechanism. To avoid buffering inputs that cannot be installed, the two source snapshots must fit within 64 MiB combined; the resulting two ZIP payloads must also fit within 64 MiB combined. With `overwrite: true`, both `expectedDatapackSha256` and `expectedResourcepackSha256` are required; each independently uses its current SHA-256 or `null` to require absence.

## Content and capacity limits

Model-authored raw files are restricted to supported datapack text extensions. Binary NBT and `pack.png` can be inventoried, hashed, copied, and packaged, but not created or edited through content tools. Resource-pack textures use only the dedicated `texture_import` operation; arbitrary binary paths or bytes are never accepted as authoring input.

Scans/builds stop at 20,000 files or 512 MiB, writes stop at 4 MiB, and MCP payloads stop at 1 MiB. Packwright reports truncation rather than silently presenting shortened content as complete.

PNG import additionally verifies the signature, critical chunk structure/order/count, CRCs, supported 8-bit non-interlaced encoding, palette/transparency consistency, and bounded decompression. Encoded PNGs stop at 8 MiB, either dimension at 4,096 pixels, total pixels at 16,777,216, and decoded RGBA data at 64 MiB. Imported output is re-encoded deterministically without ancillary metadata. A workspace PNG source requires its exact current SHA-256 and may not be a symlink.

Visual runs are content-addressed below the configured cache rather than written directly to the paired packs. Workflow state and operation locks are namespaced by a hash of the canonical workspace root, and stored state repeats that identity before it can be trusted. The cache and workspace are forbidden from containing one another, even through a symlink alias. JSON artifacts are capped at 4 MiB; one compiled artifact is capped at 2,048 files or 64 MiB. Existing run/revision directories are immutable. These controls protect integrity and capacity, but the run cache can still contain private prompts, provenance, textures, and previews and should be protected like source code.

## Network and external processes

MCP tools do not make network requests. Packwright includes no remote visual generator and needs no provider credential. `setup-version` is a separate human-invoked CLI operation; it requires explicit EULA acceptance and verifies official artifacts against Mojang's manifest digests. Offline mode forbids even that setup request.

Default setup downloads only the verified server runtime and reference data. `--client-assets` is an explicit additional choice that caches the manifest-verified official client jar and asset index. It does not download all asset objects, run the client, or add Minecraft files to the project/npm/release artifacts. In v0.3 this cache is readiness data only, not a built-in asset resolver; compilation, rendering, and validation do not load built-in asset content from it. Custom external texture/model dependencies must already exist in the sibling resource pack.

Vanilla tests use a fixed entrypoint and Packwright-controlled arguments. Callers cannot supply shell fragments, arbitrary JVM flags, or a universe path. The subprocess has a timeout, honors MCP cancellation, and writes only to allocated temporary paths and reports.

An optional operator-installed Spyglass process is isolated behind its stdio LSP protocol. It is disabled unless `PACKWRIGHT_SPYGLASS_COMMAND` is configured outside MCP input; its diagnostics are bounded and normalized before being returned to a client.

## Operator guidance

- Use a dedicated workspace containing only datapacks the client should access.
- Keep packs in source control and review diffs before running them in Minecraft.
- Use `PACKWRIGHT_READ_ONLY=true` for review-only tasks.
- Remember that read-only mode blocks workspace changes and builds; immutable drafts and previews may still be created in the private Packwright cache.
- Pin the npm package version in MCP client configuration.
- Run `doctor` after Java, cache, or permission changes.
- Do not expose the stdio process through an unauthenticated remote bridge.
- Review Minecraft logs before sharing them; they can contain usernames, paths, or pack content.
- Protect or periodically remove the configured cache when prompts, imported textures, or previews are sensitive.

Report suspected vulnerabilities through the private channel in [SECURITY.md](../SECURITY.md).
