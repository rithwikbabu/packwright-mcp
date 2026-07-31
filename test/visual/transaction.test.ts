import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { sha256Buffer } from '../../src/core/hash.js';
import { commitFileTransaction } from '../../src/visual/transaction.js';
import { temporaryWorkspace } from '../core/helpers.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup()));
});

describe('visual multi-file transactions', () => {
  it('installs new files and hash-guarded replacements together', async () => {
    const fixture = await temporaryWorkspace();
    cleanups.push(fixture.cleanup);
    await mkdir(path.join(fixture.root, 'assets'), { recursive: true });
    await writeFile(path.join(fixture.root, 'assets/existing.json'), 'old\n');

    const result = await commitFileTransaction(fixture.workspace, [
      {
        path: 'assets/existing.json',
        content: 'new\n',
        expectedSha256: sha256Buffer('old\n'),
      },
      {
        path: 'assets/nested/model.json',
        content: '{"model":true}\n',
        expectedSha256: null,
      },
    ]);

    expect(result.files.map((file) => file.path)).toEqual([
      'assets/existing.json',
      'assets/nested/model.json',
    ]);
    await expect(readFile(path.join(fixture.root, 'assets/existing.json'), 'utf8')).resolves.toBe(
      'new\n',
    );
    await expect(
      readFile(path.join(fixture.root, 'assets/nested/model.json'), 'utf8'),
    ).resolves.toBe('{"model":true}\n');
    await expect(
      stat(path.join(fixture.root, `.packwright/transactions/${result.transactionId}.json`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('checks every precondition before changing any destination', async () => {
    const fixture = await temporaryWorkspace();
    cleanups.push(fixture.cleanup);
    await writeFile(path.join(fixture.root, 'first.json'), 'first\n');
    await writeFile(path.join(fixture.root, 'second.json'), 'second\n');

    await expect(
      commitFileTransaction(fixture.workspace, [
        {
          path: 'first.json',
          content: 'changed\n',
          expectedSha256: sha256Buffer('first\n'),
        },
        {
          path: 'second.json',
          content: 'also changed\n',
          expectedSha256: '0'.repeat(64),
        },
      ]),
    ).rejects.toMatchObject({ code: 'precondition_failed' });

    await expect(readFile(path.join(fixture.root, 'first.json'), 'utf8')).resolves.toBe('first\n');
    await expect(readFile(path.join(fixture.root, 'second.json'), 'utf8')).resolves.toBe(
      'second\n',
    );
  });

  it('serializes competing transactions and rejects traversal', async () => {
    const fixture = await temporaryWorkspace();
    cleanups.push(fixture.cleanup);
    const attempts = await Promise.allSettled([
      commitFileTransaction(fixture.workspace, [
        { path: 'same.json', content: 'one\n', expectedSha256: null },
      ]),
      commitFileTransaction(fixture.workspace, [
        { path: 'same.json', content: 'two\n', expectedSha256: null },
      ]),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    await expect(
      commitFileTransaction(fixture.workspace, [
        { path: '%252e%252e/outside.png', content: Buffer.alloc(8), expectedSha256: null },
      ]),
    ).rejects.toMatchObject({ code: 'unsafe_path' });
  });

  it('creates shared parent directories safely for disjoint concurrent transactions', async () => {
    const fixture = await temporaryWorkspace();
    cleanups.push(fixture.cleanup);

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        commitFileTransaction(fixture.workspace, [
          {
            path: `shared/nested/file-${String(index)}.json`,
            content: `${String(index)}\n`,
            expectedSha256: null,
          },
        ]),
      ),
    );

    expect(results).toHaveLength(12);
    await expect(
      Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          readFile(path.join(fixture.root, `shared/nested/file-${String(index)}.json`), 'utf8'),
        ),
      ),
    ).resolves.toEqual(Array.from({ length: 12 }, (_, index) => `${String(index)}\n`));
  });

  it('orders overlapping multi-path locks and preserves null-versus-hash preconditions', async () => {
    const fixture = await temporaryWorkspace();
    cleanups.push(fixture.cleanup);
    await writeFile(path.join(fixture.root, 'first.json'), 'first\n');
    await writeFile(path.join(fixture.root, 'second.json'), 'second\n');
    const firstSha256 = sha256Buffer('first\n');
    const secondSha256 = sha256Buffer('second\n');

    const attempts = await Promise.allSettled([
      commitFileTransaction(fixture.workspace, [
        { path: 'first.json', content: 'winner-a\n', expectedSha256: firstSha256 },
        { path: 'second.json', content: 'winner-b\n', expectedSha256: secondSha256 },
      ]),
      commitFileTransaction(fixture.workspace, [
        { path: 'second.json', content: 'loser-b\n', expectedSha256: secondSha256 },
        { path: 'first.json', content: 'loser-a\n', expectedSha256: firstSha256 },
      ]),
    ]);

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    const pair = await Promise.all([
      readFile(path.join(fixture.root, 'first.json'), 'utf8'),
      readFile(path.join(fixture.root, 'second.json'), 'utf8'),
    ]);
    expect([
      ['winner-a\n', 'winner-b\n'],
      ['loser-a\n', 'loser-b\n'],
    ]).toContainEqual(pair);

    await expect(
      commitFileTransaction(fixture.workspace, [
        { path: 'first.json', content: 'must-not-change\n', expectedSha256: null },
        { path: 'new.json', content: 'must-not-exist\n', expectedSha256: null },
      ]),
    ).rejects.toMatchObject({ code: 'already_exists' });
    await expect(stat(path.join(fixture.root, 'new.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
