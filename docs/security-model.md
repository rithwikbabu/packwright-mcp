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
   |      (verified 26.2 artifacts, visual runs, and capture evidence)
   +----> disposable Java 25 server process
   |      (fresh validation/test universe only)
   +----> disposable Java 25 graphical client
          (fresh game directory, staged packs, one bundled capture mod)
```

The operator trusts the local Packwright process and chooses the workspace. MCP input, datapack/resource-pack content, imported PNGs, visual provenance, symlinks, downloaded metadata, validator output, and Minecraft subprocess output are treated as untrusted.

## Filesystem confinement

Before access, Packwright rejects absolute request paths and traversal, decodes and normalizes input, resolves existing ancestors, checks symlink targets, and verifies the canonical target remains under the canonical workspace. Resource operations additionally require a detected pack root. A visual project manifest can associate only distinct sibling datapack/resource-pack directories and is itself confined to `.packwright/projects/`.

Confinement is rechecked at write time to reduce time-of-check/time-of-use exposure. Writes use a same-directory temporary file and atomic rename. A per-path lock serializes concurrent mutations.

Creating a new file is allowed by default. Replacing an existing file requires `overwrite: true` and its current SHA-256. Deletion requires an exact file, `confirm: true`, and its current SHA-256. Directories are never recursively deleted.

These safeguards prevent accidental broad changes and stale writes; they do not defend against a malicious local account that can concurrently replace directories or modify the Packwright executable.

## Cross-pack transactions

`visual_connect` is proposal-only. It hashes the exact generated content and captures the current SHA-256—or expected absence—of every destination in both packs. `visual_commit` requires explicit confirmation and that proposal's exact content ID. For a full/limited client-capture profile in a production application, it additionally requires the exact current `expectedClientCaptureReportSha256`; an advisory validation cannot waive that precondition.

Before installation, Packwright resolves all destinations, rejects duplicates, verifies the complete precondition set, locks paths in deterministic sorted order, and stages each file beside its destination. A journal under `.packwright/transactions/` records the operation before any destination changes. Installation uses atomic filesystem operations and attempts rollback after a partial failure. If safe rollback cannot be proven, Packwright retains the journal and returns `transaction_recovery_required` rather than silently claiming success. `visual_commit` installs a canonical receipt under `.packwright/visual-commits/` in the same transaction as its generated files. Where client authority applies, that receipt binds the evidence/report/plan, runtime manifest, client/mod, full staged-pack, proposal, manifest, and output hashes. If the cache-state write is interrupted afterward, a retry verifies that receipt and every installed proposal/evidence hash before reporting the original content-addressed transaction ID.

One visual transaction is limited to 512 files and 64 MiB. There is no recursive operation and no force option that bypasses a stale hash. `project_build` separately validates exact committed snapshots and installs the datapack and resource-pack ZIPs together through the same transaction mechanism. To avoid buffering inputs that cannot be installed, the two source snapshots must fit within 64 MiB combined; the resulting two ZIP payloads must also fit within 64 MiB combined. With `overwrite: true`, both `expectedDatapackSha256` and `expectedResourcepackSha256` are required; each independently uses its current SHA-256 or `null` to require absence.

## Content and capacity limits

Model-authored raw files are restricted to supported datapack text extensions. Binary NBT and `pack.png` can be inventoried, hashed, copied, and packaged, but not created or edited through content tools. Resource-pack textures use only the dedicated `texture_import` operation; arbitrary binary paths or bytes are never accepted as authoring input.

Scans/builds stop at 20,000 files or 512 MiB, writes stop at 4 MiB, and MCP payloads stop at 1 MiB. Packwright reports truncation rather than silently presenting shortened content as complete.

PNG import additionally verifies the signature, critical chunk structure/order/count, CRCs, supported 8-bit non-interlaced encoding, palette/transparency consistency, and bounded decompression. Encoded PNGs stop at 8 MiB, either dimension at 4,096 pixels, total pixels at 16,777,216, and decoded RGBA data at 64 MiB. Imported output is re-encoded deterministically without ancillary metadata. A workspace PNG source requires its exact current SHA-256 and may not be a symlink.

Visual runs are content-addressed below the configured cache rather than written directly to the paired packs. Workflow state and operation locks are namespaced by a hash of the canonical workspace root, and stored state repeats that identity before it can be trusted. The cache and workspace are forbidden from containing one another, even through a symlink alias. JSON artifacts are capped at 4 MiB; one compiled artifact is capped at 2,048 files or 64 MiB; each raw client-capture PNG/report/log blob is capped at 16 MiB. Existing run/revision directories are immutable. These controls protect integrity and capacity, but the run cache can still contain private prompts, provenance, textures, CPU previews, actual-client frames, environment metadata, bounded logs, and locally licensed Minecraft artifacts and should be protected like source code.

## Network and external processes

MCP tools do not make network requests. Packwright includes no remote visual generator and needs no provider credential. `setup-version` is a separate human-invoked CLI operation; it requires explicit EULA acceptance and verifies official artifacts against Mojang's manifest digests. Offline mode forbids even that setup request.

Default setup downloads only the verified server runtime and reference data. `--client-assets` is an explicit additional choice that caches the manifest-verified official client jar and asset index. `--client-capture` implies that choice and downloads the full platform-specific launcher graph: all indexed asset objects, permitted libraries/native classifiers, pinned Fabric Loader `0.19.3`, and its required pinned libraries. Mojang artifacts are checked by manifest SHA-1 and size; pinned Fabric artifacts are additionally checked by SHA-256. Setup does not launch the client or add downloaded files to the workspace, npm package, GitHub artifacts, or release assets. Custom external texture/model dependencies must already exist in the sibling resource-pack proposal.

Vanilla tests use a fixed entrypoint and Packwright-controlled arguments. Callers cannot supply shell fragments, arbitrary JVM flags, or a universe path. The subprocess has a timeout, honors MCP cancellation, and writes only to allocated temporary paths and reports.

`visual_capture` requires `confirm: true`, exact immutable run/proposal identities, prepared local artifacts, Java 25, and a graphical-session preflight. The launcher uses a fixed Fabric `KnotClient` entrypoint and fixed offline-developer, multiplayer-disabled, and chat-disabled arguments. It stages only the exact proposal plus the bundled Packwright capture mod in a new disposable game directory. Preflight rejects a bundled capture-mod path, size, or digest that differs from the pinned runtime identity. The protocol accepts bounded scene fields and the exact generated item stack—not credentials, arbitrary commands, a user save, an external mod, JVM flags, or shell input.

The canonical capture plan/report and verified SHA-256 evidence chain hash-bind each scene's `viewKind` and `requiredForAuthority` status; this is an integrity relationship, not a keyed digital signature. Required `first_person_vanilla` scenes forbid the injected reference arm and preserve exact stock gameplay composition. Optional `first_person_scale_reference` scenes are paired to a required vanilla scene, explicitly carry `augmented_qa_reference`, and cannot be relabeled or substituted to satisfy authority. Their Minecraft-rendered arm is a QA-only scale aid, never WYSIWYG gameplay evidence. Top-level capture authority is explicitly scoped to `required_views_only`.

The capture mod writes fixed-name PNGs, a canonical report, bounded full log, and final completion sentinel. Packwright follows no output symlinks and verifies every report/scene/input/hash relationship before indexing evidence. Cancellation, timeout, failure, and success all trigger cleanup of the disposable game directory. Required stock captures use the actual OpenGL framebuffer and are authoritative for that environment, not a cross-hardware reproducibility promise; augmented scale-reference captures remain supplemental regardless of renderer provenance.

An optional operator-installed Spyglass process is isolated behind its stdio LSP protocol. It is disabled unless `PACKWRIGHT_SPYGLASS_COMMAND` is configured outside MCP input; its diagnostics are bounded and normalized before being returned to a client.

## Operator guidance

- Use a dedicated workspace containing only datapacks the client should access.
- Keep packs in source control and review diffs before running them in Minecraft.
- Use `PACKWRIGHT_READ_ONLY=true` for review-only tasks.
- Remember that read-only mode blocks workspace changes and builds; immutable drafts and previews may still be created in the private Packwright cache.
- Pin the npm package version in MCP client configuration.
- Run `doctor` after Java, cache, or permission changes.
- Run client capture only on a trusted interactive macOS session; close overlays and other software that can inject into OpenGL clients.
- Do not expose the stdio process through an unauthenticated remote bridge.
- Review Minecraft logs before sharing them; they can contain usernames, paths, or pack content.
- Protect or periodically remove the configured cache when prompts, imported textures, previews, framebuffer captures, logs, or Minecraft artifacts are sensitive.

Report suspected vulnerabilities through the private channel in [SECURITY.md](../SECURITY.md).
