import { describe, expect, it } from 'vitest';

import { MAX_MCP_PAYLOAD_BYTES } from '../../src/core/limits.js';
import {
  DatapackCreateInputSchema,
  DatapackTestInputSchema,
  ResourceIdSchema,
  ResourceUpsertInputSchema,
} from '../../src/mcp/schemas.js';

describe('MCP input schemas', () => {
  it('applies safe defaults to datapack creation', () => {
    const parsed = DatapackCreateInputSchema.parse({
      project: 'packs/example',
      namespace: 'example',
      description: 'Example pack',
    });

    expect(parsed).toMatchObject({
      minecraftVersion: '26.2',
      dryRun: false,
    });
  });

  it('rejects unknown fields and unsafe project paths', () => {
    expect(() =>
      DatapackCreateInputSchema.parse({
        project: '../outside',
        namespace: 'example',
        description: 'Example pack',
      }),
    ).toThrow();

    expect(() =>
      DatapackCreateInputSchema.parse({
        project: 'example',
        namespace: 'example',
        description: 'Example pack',
        unexpected: true,
      }),
    ).toThrow();
  });

  it('requires an optimistic precondition for overwrites', () => {
    const base = {
      project: 'example',
      selector: {
        kind: 'resource' as const,
        resourceType: 'function' as const,
        id: 'example:load',
      },
      content: { kind: 'text' as const, text: 'say hello' },
    };

    expect(() => ResourceUpsertInputSchema.parse({ ...base, overwrite: true })).toThrow(
      /expectedSha256/u,
    );

    expect(
      ResourceUpsertInputSchema.parse({
        ...base,
        overwrite: true,
        expectedSha256: 'a'.repeat(64),
      }),
    ).toMatchObject({ overwrite: true, dryRun: false });
  });

  it('does not advertise binary NBT resources as authorable text', () => {
    expect(() =>
      ResourceUpsertInputSchema.parse({
        project: 'example',
        selector: {
          kind: 'resource',
          resourceType: 'structure',
          id: 'example:test',
        },
        content: { kind: 'text', text: 'not nbt' },
      }),
    ).toThrow();
  });

  it('rejects an aggregate request over the MCP payload limit', () => {
    const independentlyValidText = 'a'.repeat(Math.floor(MAX_MCP_PAYLOAD_BYTES / 2));
    const parsed = DatapackCreateInputSchema.safeParse({
      project: 'example',
      namespace: 'example',
      description: 'Example pack',
      loadFunction: independentlyValidText,
      tickFunction: independentlyValidText,
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.message.includes('MCP payload limit'))).toBe(
        true,
      );
    }
  });

  it('requires exact normalized resource IDs for GameTest selections', () => {
    for (const value of ['foo:../bar', 'foo:a//b', 'foo:path/', 'foo:*']) {
      expect(ResourceIdSchema.safeParse(value).success).toBe(false);
    }
    expect(ResourceIdSchema.safeParse('foo:path/to/test').success).toBe(true);
    expect(DatapackTestInputSchema.safeParse({ project: 'example', tests: [] }).success).toBe(
      false,
    );
  });
});
