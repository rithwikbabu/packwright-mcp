import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';

import { assertRuntimePathSeparation, type RuntimeConfig } from './config.js';
import { getCacheStatus } from './minecraft/cache.js';
import { getJavaVersion } from './minecraft/java.js';
import { preflightMinecraftClientCapture } from './minecraft/client-capture.js';
import { getSpyglassStatus, PINNED_SPYGLASS_VERSION } from './validation/spyglass.js';

export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly required: boolean;
  readonly message: string;
}

export interface DoctorResult {
  readonly ok: boolean;
  readonly checks: readonly DoctorCheck[];
}

function nodeMajor(): number {
  return Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
}

export async function runDoctor(
  config: RuntimeConfig,
  signal?: AbortSignal,
): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const major = nodeMajor();
  checks.push({
    name: 'node',
    ok: major >= 20,
    required: true,
    message: `Node.js ${process.versions.node} (${major >= 20 ? 'supported' : 'requires 20+'})`,
  });

  let workspaceIsDirectory = false;
  try {
    const info = await stat(config.workspaceRoot);
    if (!info.isDirectory()) throw new Error('Workspace path is not a directory');
    await access(config.workspaceRoot, constants.R_OK);
    workspaceIsDirectory = true;
    checks.push({
      name: 'workspace_read',
      ok: true,
      required: true,
      message: `Workspace is readable: ${config.workspaceRoot}`,
    });
  } catch (error) {
    checks.push({
      name: 'workspace_read',
      ok: false,
      required: true,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    if (!workspaceIsDirectory) throw new Error('Workspace path is not a directory');
    await access(config.workspaceRoot, constants.W_OK);
    checks.push({
      name: 'workspace_write',
      ok: true,
      required: !config.readOnly,
      message: config.readOnly
        ? 'Workspace is writable, but Packwright is configured read-only'
        : 'Workspace is writable',
    });
  } catch (error) {
    checks.push({
      name: 'workspace_write',
      ok: config.readOnly,
      required: !config.readOnly,
      message: config.readOnly
        ? 'Workspace is not writable (acceptable in read-only mode)'
        : error instanceof Error
          ? error.message
          : String(error),
    });
  }

  try {
    await assertRuntimePathSeparation(config);
    checks.push({
      name: 'workspace_cache_separation',
      ok: true,
      required: true,
      message: 'Workspace and cache resolve to separate directory trees',
    });
  } catch (error) {
    checks.push({
      name: 'workspace_cache_separation',
      ok: false,
      required: true,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const java = await getJavaVersion(config.javaCommand, signal);
  checks.push({
    name: 'java_25',
    ok: java.available && java.major === 25,
    required: false,
    message:
      java.available && java.major === 25
        ? `${java.description} is ready for vanilla validation`
        : `${java.description}; Java 25 is required only for setup and GameTests`,
  });

  const cache = await getCacheStatus(config.cacheDir, true);
  checks.push({
    name: 'minecraft_cache',
    ok: cache.ready,
    required: false,
    message: cache.ready
      ? `Verified Minecraft 26.2 cache is ready at ${config.cacheDir}`
      : `Cache is incomplete (jar=${String(cache.jar)}, jarVerified=${String(cache.jarVerified)}, metadata=${String(cache.versionMetadata)}, metadataVerified=${String(cache.versionMetadataVerified)}, EULA=${String(cache.acceptedEula)}, commands=${String(cache.commands)}, registries=${String(cache.registries)})`,
  });

  const clientAssets = cache.clientAssets;
  checks.push({
    name: 'minecraft_client_assets',
    ok: clientAssets?.ready ?? false,
    required: false,
    message:
      clientAssets?.ready === true
        ? 'Verified Minecraft 26.2 client jar and asset index are ready for client-profile lookups'
        : 'Optional client metadata is not prepared; use setup-version 26.2 --accept-minecraft-eula --client-assets',
  });

  const clientCapture = await preflightMinecraftClientCapture(config, signal).catch(
    (error: unknown) => ({
      ready: false,
      status: 'setup_required' as const,
      messages: [error instanceof Error ? error.message : String(error)],
    }),
  );
  checks.push({
    name: 'minecraft_client_capture',
    ok: clientCapture.ready,
    required: false,
    message: clientCapture.ready
      ? 'The hash-verified Minecraft 26.2 client runtime, capture mod, and graphical session are ready'
      : `Authoritative client capture needs setup: ${clientCapture.messages.join(' ')}`,
  });

  if (config.spyglassCommand === undefined) {
    checks.push({
      name: 'spyglass',
      ok: false,
      required: false,
      message: `Optional pinned Spyglass ${PINNED_SPYGLASS_VERSION} adapter is disabled; set PACKWRIGHT_SPYGLASS_COMMAND to a reviewed executable`,
    });
  } else {
    const spyglass = await getSpyglassStatus(config.spyglassCommand, signal);
    checks.push({
      name: 'spyglass',
      ok: spyglass.compatible,
      required: false,
      message: spyglass.description,
    });
  }

  return {
    ok: checks.every((check) => !check.required || check.ok),
    checks,
  };
}
