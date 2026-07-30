import { MAX_DIFF_BYTES } from './limits.js';
import { sha256Buffer } from './hash.js';
import type { TextDiff } from './types.js';

function prefixed(prefix: string, lines: readonly string[]): string[] {
  return lines.map((line) => `${prefix}${line}`);
}

export function createTextDiff(
  before: string | undefined,
  after: string | undefined,
  label: string,
): TextDiff {
  const beforeLines = before?.split('\n') ?? [];
  const afterLines = after?.split('\n') ?? [];
  let commonStart = 0;
  while (
    commonStart < beforeLines.length &&
    commonStart < afterLines.length &&
    beforeLines[commonStart] === afterLines[commonStart]
  ) {
    commonStart += 1;
  }
  let commonEnd = 0;
  while (
    commonEnd < beforeLines.length - commonStart &&
    commonEnd < afterLines.length - commonStart &&
    beforeLines[beforeLines.length - 1 - commonEnd] ===
      afterLines[afterLines.length - 1 - commonEnd]
  ) {
    commonEnd += 1;
  }

  const beforeChanged = beforeLines.slice(commonStart, commonEnd === 0 ? undefined : -commonEnd);
  const afterChanged = afterLines.slice(commonStart, commonEnd === 0 ? undefined : -commonEnd);
  const firstChangedLine = String(commonStart + 1);
  const header = [
    `--- a/${label}`,
    `+++ b/${label}`,
    `@@ -${firstChangedLine} +${firstChangedLine} @@`,
  ];
  const full = [...header, ...prefixed('-', beforeChanged), ...prefixed('+', afterChanged)].join(
    '\n',
  );
  const encoded = Buffer.from(full, 'utf8');
  const truncated = encoded.byteLength > MAX_DIFF_BYTES;
  const unified = truncated
    ? `${encoded.subarray(0, MAX_DIFF_BYTES).toString('utf8')}\n... diff truncated ...`
    : full;

  return {
    beforeSha256: before === undefined ? undefined : sha256Buffer(before),
    afterSha256: after === undefined ? undefined : sha256Buffer(after),
    unified,
    truncated,
  };
}
