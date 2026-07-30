import { describe, expect, it } from 'vitest';

import { decodeProjectId, encodeProjectId, projectManifestUri } from '../../src/mcp/uris.js';

describe('Packwright project resource IDs', () => {
  it('round-trips safe Unicode project paths as canonical base64url', () => {
    const project = 'packs/redstone café';
    const projectId = encodeProjectId(project);

    expect(projectId).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(decodeProjectId(projectId)).toBe(project);
    expect(projectManifestUri(project)).toBe(`packwright://projects/${projectId}/manifest`);
  });

  it('rejects traversal before encoding and after decoding', () => {
    expect(() => encodeProjectId('../outside')).toThrow();

    const traversalId = Buffer.from('packs/../../outside', 'utf8').toString('base64url');
    expect(() => decodeProjectId(traversalId)).toThrow();
  });

  it('rejects padded and otherwise non-canonical IDs', () => {
    const canonical = encodeProjectId('example');
    expect(() => decodeProjectId(`${canonical}=`)).toThrow();
  });
});
