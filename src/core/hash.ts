import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export function sha256Buffer(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}
