import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ExternalSpyglassAdapter } from '../../src/validation/spyglass.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup()));
});

const RESPONSIVE_SERVER = String.raw`#!/usr/bin/env node
let buffer = Buffer.alloc(0);

function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write(
    'Content-Length: ' + Buffer.byteLength(body, 'utf8') + '\r\n\r\n' + body,
  );
}

function respondAfterStderrFlood(id) {
  let remaining = 2 * 1024 * 1024;
  const writeMore = () => {
    while (remaining > 0) {
      const length = Math.min(remaining, 64 * 1024);
      remaining -= length;
      if (!process.stderr.write(Buffer.alloc(length, 120))) {
        process.stderr.once('drain', writeMore);
        return;
      }
    }
    send({ jsonrpc: '2.0', id, result: { capabilities: {} } });
  };
  writeMore();
}

function handle(message) {
  if (message.method === 'initialize') {
    respondAfterStderrFlood(message.id);
    return;
  }
  if (message.method === 'textDocument/didOpen') {
    const diagnostics = Array.from({ length: 2100 }, (_, index) => ({
      severity: 2,
      code: 'fake.' + index,
      message: index === 0 ? 'm'.repeat(100000) : 'diagnostic ' + index,
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      },
    }));
    send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri: message.params.textDocument.uri, diagnostics },
    });
    return;
  }
  if (message.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: message.id, result: null });
    return;
  }
  if (message.method === 'exit') process.exit(0);
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const separator = buffer.indexOf('\r\n\r\n');
    if (separator < 0) return;
    const header = buffer.subarray(0, separator).toString('ascii');
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) process.exit(2);
    const length = Number.parseInt(match[1], 10);
    const end = separator + 4 + length;
    if (buffer.length < end) return;
    const message = JSON.parse(buffer.subarray(separator + 4, end).toString('utf8'));
    buffer = buffer.subarray(end);
    handle(message);
  }
});
`;

const HOSTILE_SERVER = String.raw`#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import path from 'node:path';

writeFileSync(path.join(process.cwd(), 'fake-spyglass.pid'), String(process.pid));
process.on('SIGTERM', () => {});
process.stdout.write('Content-Length: 999999999\r\n\r\n');
setInterval(() => {}, 1000);
`;

async function fixture(serverSource: string): Promise<{
  readonly root: string;
  readonly pack: string;
  readonly command: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'packwright-spyglass-'));
  const pack = path.join(root, 'pack');
  const command = path.join(root, 'fake-spyglass.mjs');
  await mkdir(path.join(pack, 'data/demo/function'), { recursive: true });
  await writeFile(path.join(pack, 'data/demo/function/load.mcfunction'), 'say validator test\n');
  await writeFile(command, serverSource, { mode: 0o755 });
  cleanups.push(async () => {
    try {
      const pid = Number.parseInt(await readFile(path.join(pack, 'fake-spyglass.pid'), 'utf8'), 10);
      if (Number.isSafeInteger(pid)) process.kill(pid, 'SIGKILL');
    } catch {
      // The normal case is that the adapter already reaped the fake server.
    }
    await rm(root, { recursive: true, force: true });
  });
  return { root, pack, command };
}

describe.skipIf(process.platform === 'win32')('external Spyglass safety boundary', () => {
  it('drains stderr and bounds normalized diagnostics', async () => {
    const { pack, command } = await fixture(RESPONSIVE_SERVER);
    const diagnostics = await new ExternalSpyglassAdapter(command).validate(pack);

    expect(diagnostics.length).toBeLessThanOrEqual(2_001);
    expect(diagnostics[0]?.message.length).toBeLessThan(17_000);
    expect(diagnostics.at(-1)).toMatchObject({
      code: 'spyglass.payload_truncated',
      severity: 'information',
    });
  }, 10_000);

  it('rejects oversized frames and force-kills a server that ignores SIGTERM', async () => {
    const { pack, command } = await fixture(HOSTILE_SERVER);
    const startedAt = Date.now();

    await expect(new ExternalSpyglassAdapter(command).validate(pack)).rejects.toThrow(
      /oversized LSP frame/u,
    );
    expect(Date.now() - startedAt).toBeLessThan(6_000);

    const pid = Number.parseInt(await readFile(path.join(pack, 'fake-spyglass.pid'), 'utf8'), 10);
    let running = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') running = false;
      else throw error;
    }
    expect(running).toBe(false);
  }, 10_000);
});
