import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

interface PackageMetadata {
  readonly mcpName?: unknown;
  readonly name?: unknown;
  readonly version?: unknown;
}

interface ServerMetadata {
  readonly description?: unknown;
  readonly name?: unknown;
  readonly packages?: readonly {
    readonly identifier?: unknown;
    readonly version?: unknown;
  }[];
  readonly version?: unknown;
}

const packageMetadata = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageMetadata;
const serverMetadata = JSON.parse(
  readFileSync(new URL('../server.json', import.meta.url), 'utf8'),
) as ServerMetadata;

describe('public release metadata', () => {
  it('keeps package and MCP Registry identities aligned', () => {
    expect(packageMetadata.name).toBe('@rithwikbabu/packwright-mcp');
    expect(packageMetadata.mcpName).toBe('io.github.rithwikbabu/packwright-mcp');
    expect(serverMetadata.name).toBe(packageMetadata.mcpName);
    expect(serverMetadata.version).toBe(packageMetadata.version);
    expect(serverMetadata.packages?.[0]?.identifier).toBe(packageMetadata.name);
    expect(serverMetadata.packages?.[0]?.version).toBe(packageMetadata.version);
  });

  it('meets the MCP Registry description limit', () => {
    expect(typeof serverMetadata.description).toBe('string');
    expect((serverMetadata.description as string).length).toBeGreaterThan(0);
    expect((serverMetadata.description as string).length).toBeLessThanOrEqual(100);
  });
});
