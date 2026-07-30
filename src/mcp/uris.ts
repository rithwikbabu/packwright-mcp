import { PackwrightError } from '../core/errors.js';
import { RelativePathSchema } from './schemas.js';

export const PACKWRIGHT_URI_SCHEME = 'packwright';
export const WORKSPACE_PACKS_URI = 'packwright://workspace/packs';
export const SUPPORTED_VERSIONS_URI = 'packwright://versions/supported';
export const PROJECT_MANIFEST_URI_TEMPLATE = 'packwright://projects/{projectId}/manifest';
export const PROJECT_RESOURCES_URI_TEMPLATE = 'packwright://projects/{projectId}/resources';
export const PROJECT_DIAGNOSTICS_URI_TEMPLATE = 'packwright://projects/{projectId}/diagnostics';
export const VERSION_REGISTRIES_URI_TEMPLATE = 'packwright://versions/{version}/registries';

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

export function encodeProjectId(project: string): string {
  const parsed = RelativePathSchema.safeParse(project);
  if (!parsed.success) {
    throw new PackwrightError('invalid_argument', `Cannot encode invalid project path: ${project}`);
  }

  return Buffer.from(parsed.data, 'utf8').toString('base64url');
}

export function decodeProjectId(projectId: string): string {
  if (!BASE64URL_PATTERN.test(projectId)) {
    throw new PackwrightError('invalid_argument', 'Invalid project resource ID');
  }

  let decoded: string;
  try {
    const bytes = Buffer.from(projectId, 'base64url');
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new PackwrightError('invalid_argument', 'Invalid project resource ID');
  }

  if (Buffer.from(decoded, 'utf8').toString('base64url') !== projectId) {
    throw new PackwrightError('invalid_argument', 'Project resource ID is not canonical base64url');
  }

  const parsed = RelativePathSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new PackwrightError(
      'invalid_argument',
      'Project resource ID does not contain a safe project path',
    );
  }
  return parsed.data;
}

export function projectManifestUri(project: string): string {
  return `packwright://projects/${encodeProjectId(project)}/manifest`;
}

export function projectResourcesUri(project: string): string {
  return `packwright://projects/${encodeProjectId(project)}/resources`;
}

export function projectDiagnosticsUri(project: string): string {
  return `packwright://projects/${encodeProjectId(project)}/diagnostics`;
}

export function versionRegistriesUri(version: '26.2'): string {
  return `packwright://versions/${version}/registries`;
}
