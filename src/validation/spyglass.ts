import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { MAX_SCAN_BYTES, MAX_SCAN_FILES, MAX_TEXT_WRITE_BYTES } from '../core/limits.js';
import type { Diagnostic, ValidationAdapter } from '../core/types.js';
import { runProcess } from '../runtime/process.js';

interface JsonRpcMessage {
  readonly jsonrpc: '2.0';
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface PublishDiagnosticsParams {
  readonly uri?: unknown;
  readonly diagnostics?: unknown;
}

const SUPPORTED_EXTENSIONS = new Set(['.json', '.mcfunction', '.mcmeta', '.snbt']);
const MAX_LSP_HEADER_BYTES = 16 * 1024;
const MAX_LSP_INBOUND_FRAME_BYTES = 2 * 1024 * 1024;
// JSON escaping can expand a text document by up to six bytes per input byte.
const MAX_LSP_OUTBOUND_FRAME_BYTES = MAX_TEXT_WRITE_BYTES * 6 + 64 * 1024;
const MAX_LSP_STDERR_BYTES = 64 * 1024;
const MAX_LSP_WRITE_WAIT_MS = 15_000;
const MAX_SPYGLASS_DIAGNOSTICS = 2_000;
const MAX_SPYGLASS_DIAGNOSTIC_BYTES = 512 * 1024;
const MAX_DIAGNOSTIC_MESSAGE_BYTES = 16 * 1024;
const MAX_DIAGNOSTIC_CODE_BYTES = 512;
const MAX_DIAGNOSTIC_URI_BYTES = 16 * 1024;
const DIAGNOSTIC_MINIMUM_WAIT_MS = 1_000;
const DIAGNOSTIC_QUIET_PERIOD_MS = 750;
const SPYGLASS_SHUTDOWN_GRACE_MS = 2_000;

/** The only Spyglass release whose diagnostics Packwright v0.1 normalizes. */
export const PINNED_SPYGLASS_VERSION = '0.4.65';

export interface SpyglassStatus {
  readonly available: boolean;
  readonly compatible: boolean;
  readonly version?: string;
  readonly description: string;
}

export async function getSpyglassStatus(
  command: string,
  signal?: AbortSignal,
): Promise<SpyglassStatus> {
  try {
    const result = await runProcess({
      command,
      args: ['--version'],
      timeoutMs: 5_000,
      ...(signal === undefined ? {} : { signal }),
      maxOutputBytes: 64 * 1024,
    });
    const output = `${result.stdout}\n${result.stderr}`.trim();
    const version = /(?:^|\D)(\d+\.\d+\.\d+)(?:\D|$)/u.exec(output)?.[1];
    const available = result.exitCode === 0 && !result.timedOut && !result.cancelled;
    const compatible = available && version === PINNED_SPYGLASS_VERSION;
    return {
      available,
      compatible,
      ...(version === undefined ? {} : { version }),
      description: compatible
        ? `Spyglass ${PINNED_SPYGLASS_VERSION} is available`
        : available
          ? `Spyglass reported ${version ?? 'no semantic version'}; Packwright requires ${PINNED_SPYGLASS_VERSION}`
          : 'The configured Spyglass executable failed its version check',
    };
  } catch (error) {
    return {
      available: false,
      compatible: false,
      description: error instanceof Error ? error.message : String(error),
    };
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function languageId(filename: string): string {
  if (filename.endsWith('.mcfunction')) return 'mcfunction';
  if (filename.endsWith('.snbt')) return 'snbt';
  return 'json';
}

function severity(value: unknown): Diagnostic['severity'] {
  switch (value) {
    case 1:
      return 'error';
    case 2:
      return 'warning';
    case 4:
      return 'hint';
    default:
      return 'information';
  }
}

function position(value: unknown): { line: number; character: number } {
  const object = asObject(value);
  const boundedInteger = (candidate: unknown): number =>
    typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0
      ? candidate
      : 0;
  return {
    line: boundedInteger(object?.line),
    character: boundedInteger(object?.character),
  };
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length <= maximumBytes) return value;
  return `${encoded.subarray(0, maximumBytes).toString('utf8')}...`;
}

function errorText(value: unknown): string {
  try {
    return truncateUtf8(JSON.stringify(value), MAX_DIAGNOSTIC_MESSAGE_BYTES);
  } catch {
    return 'unserializable LSP error';
  }
}

class LspConnection {
  readonly child: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly onNotification: (message: JsonRpcMessage) => void;
  private readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  private closedSettled = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private termination: Promise<void> | undefined;
  private fatalError: Error | undefined;
  private stderrSnippet = Buffer.alloc(0);
  private stderrTruncated = false;

  constructor(command: string, cwd: string, onNotification: (message: JsonRpcMessage) => void) {
    this.onNotification = onNotification;
    this.closed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
    this.child = spawn(command, ['--stdio'], {
      cwd,
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', (chunk: Buffer) => {
      try {
        this.buffer = Buffer.concat([this.buffer, chunk], this.buffer.length + chunk.length);
        this.parse();
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        this.fail(normalized);
        void this.terminate().catch(() => undefined);
      }
    });
    // Always consume stderr so a verbose language server cannot block on a
    // full pipe. Retain only a small bounded tail for actionable errors.
    this.child.stderr.on('data', (chunk: Buffer) => {
      if (this.stderrSnippet.length >= MAX_LSP_STDERR_BYTES) {
        this.stderrTruncated = true;
        return;
      }
      const remaining = MAX_LSP_STDERR_BYTES - this.stderrSnippet.length;
      this.stderrSnippet = Buffer.concat([
        this.stderrSnippet,
        chunk.length <= remaining ? chunk : chunk.subarray(0, remaining),
      ]);
      if (chunk.length > remaining) this.stderrTruncated = true;
    });
    this.child.once('error', (error) => {
      this.fail(error);
      this.markClosed();
    });
    this.child.once('close', (code) => {
      if (this.pending.size > 0) {
        const stderr = this.stderrSnippet.toString('utf8').trim();
        const suffix = stderr
          ? `: ${stderr}${this.stderrTruncated ? '\n... stderr truncated ...' : ''}`
          : '';
        this.fail(new Error(`Spyglass exited unexpectedly with code ${String(code)}${suffix}`));
      }
      this.markClosed();
    });
  }

  private markClosed(): void {
    if (this.closedSettled) return;
    this.closedSettled = true;
    this.resolveClosed();
  }

  private fail(error: Error): void {
    this.fatalError ??= error;
    this.rejectAll(error);
  }

  private parse(): void {
    for (;;) {
      const separator = this.buffer.indexOf('\r\n\r\n');
      if (separator < 0) {
        if (this.buffer.length > MAX_LSP_HEADER_BYTES) {
          throw new Error('Spyglass sent an oversized LSP header.');
        }
        return;
      }
      if (separator > MAX_LSP_HEADER_BYTES) {
        throw new Error('Spyglass sent an oversized LSP header.');
      }
      const header = this.buffer.subarray(0, separator).toString('ascii');
      const matches = [...header.matchAll(/(?:^|\r\n)Content-Length:\s*(\d+)\s*(?=\r\n|$)/giu)];
      if (matches.length !== 1 || matches[0]?.[1] === undefined) {
        throw new Error('Spyglass sent an invalid LSP Content-Length header.');
      }
      const length = Number.parseInt(matches[0][1], 10);
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_LSP_INBOUND_FRAME_BYTES) {
        throw new Error('Spyglass sent an oversized LSP frame.');
      }
      const end = separator + 4 + length;
      if (this.buffer.length < end) return;
      const body = this.buffer.subarray(separator + 4, end).toString('utf8');
      this.buffer = this.buffer.subarray(end);
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(body) as JsonRpcMessage;
      } catch {
        throw new Error('Spyglass sent malformed LSP JSON.');
      }
      this.handle(message);
    }
  }

  private handle(message: JsonRpcMessage): void {
    if (message.id !== undefined && message.method === undefined) {
      const request = this.pending.get(message.id);
      if (request === undefined) return;
      clearTimeout(request.timer);
      this.pending.delete(message.id);
      if (message.error === undefined) request.resolve(message.result);
      else request.reject(new Error(`Spyglass LSP error: ${errorText(message.error)}`));
      return;
    }
    if (message.method !== undefined && message.id !== undefined) {
      const result =
        message.method === 'workspace/workspaceFolders'
          ? []
          : message.method === 'workspace/configuration'
            ? []
            : null;
      void this.write({ jsonrpc: '2.0', id: message.id, result }).catch((error: unknown) => {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        void this.terminate().catch(() => undefined);
      });
      return;
    }
    this.onNotification(message);
  }

  private write(message: JsonRpcMessage): Promise<void> {
    if (this.fatalError !== undefined) return Promise.reject(this.fatalError);
    const body = JSON.stringify(message);
    const bodyBytes = Buffer.byteLength(body, 'utf8');
    if (bodyBytes > MAX_LSP_OUTBOUND_FRAME_BYTES) {
      return Promise.reject(new Error('Packwright refused to send an oversized LSP frame.'));
    }
    const frame = `Content-Length: ${String(bodyBytes)}\r\n\r\n${body}`;
    const operation = this.writeQueue.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (this.fatalError !== undefined) {
            reject(this.fatalError);
            return;
          }
          if (this.child.stdin.destroyed || !this.child.stdin.writable) {
            reject(new Error('Spyglass LSP stdin is not writable.'));
            return;
          }
          let settled = false;
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error('Timed out writing to Spyglass LSP stdin.'));
          }, MAX_LSP_WRITE_WAIT_MS);
          const complete = (error?: Error | null): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve();
          };
          try {
            this.child.stdin.write(frame, complete);
          } catch (error) {
            complete(error instanceof Error ? error : new Error(String(error)));
          }
        }),
    );
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  request(method: string, params: unknown, timeoutMs = 15_000): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      if (this.fatalError !== undefined) {
        reject(this.fatalError);
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Spyglass LSP request timed out: ${method}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      void this.write({ jsonrpc: '2.0', id, method, params }).catch((error: unknown) => {
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  notify(method: string, params?: unknown): Promise<void> {
    return this.write({
      jsonrpc: '2.0',
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  private sendSignal(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid === undefined) return;
    try {
      if (process.platform !== 'win32') process.kill(-pid, signal);
      else this.child.kill(signal);
    } catch {
      try {
        this.child.kill(signal);
      } catch {
        // The process may already have exited between the state check and kill.
      }
    }
  }

  private async waitForClose(timeoutMs: number): Promise<boolean> {
    if (this.closedSettled || this.child.exitCode !== null || this.child.signalCode !== null) {
      return true;
    }
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const closed = this.closed.then(() => true as const);
    const result = await Promise.race([closed, timedOut]);
    if (timer !== undefined) clearTimeout(timer);
    return result;
  }

  terminate(): Promise<void> {
    this.termination ??= this.terminateOnce();
    return this.termination;
  }

  private async terminateOnce(): Promise<void> {
    if (await this.waitForClose(0)) return;
    this.sendSignal('SIGTERM');
    if (await this.waitForClose(SPYGLASS_SHUTDOWN_GRACE_MS)) return;
    this.sendSignal('SIGKILL');
    if (!(await this.waitForClose(SPYGLASS_SHUTDOWN_GRACE_MS))) {
      throw new Error('Spyglass did not exit after SIGKILL.');
    }
  }

  private rejectAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}

async function textDocuments(root: string): Promise<string[]> {
  const output: string[] = [];
  let totalBytes = 0;
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await visit(absolute);
      } else if (
        info.isFile() &&
        info.size <= MAX_TEXT_WRITE_BYTES &&
        SUPPORTED_EXTENSIONS.has(path.extname(entry.name))
      ) {
        output.push(absolute);
        totalBytes += info.size;
        if (output.length > MAX_SCAN_FILES || totalBytes > MAX_SCAN_BYTES) {
          throw new Error('Spyglass document discovery exceeded the datapack scan limits.');
        }
      }
    }
  }
  await visit(root);
  return output.sort((left, right) => left.localeCompare(right, 'en'));
}

async function readDocument(filename: string): Promise<string> {
  const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
  const handle = await open(filename, constants.O_RDONLY | noFollow);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_TEXT_WRITE_BYTES) {
      throw new Error('Spyglass document changed or exceeded the text size limit.');
    }
    const bytes = await handle.readFile();
    if (bytes.length > MAX_TEXT_WRITE_BYTES) {
      throw new Error('Spyglass document changed or exceeded the text size limit.');
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally {
    await handle.close();
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

export class ExternalSpyglassAdapter implements ValidationAdapter {
  readonly name = 'spyglass';
  readonly command: string;

  constructor(command: string) {
    this.command = command;
  }

  async validate(packRoot: string, signal?: AbortSignal): Promise<readonly Diagnostic[]> {
    const diagnostics: Diagnostic[] = [];
    const diagnosticState = { bytes: 0, truncated: false };
    let lastDiagnosticAt = Date.now();
    const connection = new LspConnection(this.command, packRoot, (message) => {
      if (message.method !== 'textDocument/publishDiagnostics') return;
      lastDiagnosticAt = Date.now();
      const params = (message.params ?? {}) as PublishDiagnosticsParams;
      if (
        typeof params.uri !== 'string' ||
        Buffer.byteLength(params.uri, 'utf8') > MAX_DIAGNOSTIC_URI_BYTES ||
        !Array.isArray(params.diagnostics)
      ) {
        diagnosticState.truncated = true;
        return;
      }
      let absolute: string;
      try {
        absolute = fileURLToPath(params.uri);
      } catch {
        return;
      }
      if (!isWithin(packRoot, absolute)) return;
      const relative = path.relative(packRoot, absolute).split(path.sep).join('/');
      if (relative.length === 0 || relative.length > 1_024) {
        diagnosticState.truncated = true;
        return;
      }
      for (const raw of params.diagnostics) {
        const item = asObject(raw);
        if (item === undefined || typeof item.message !== 'string') continue;
        if (diagnostics.length >= MAX_SPYGLASS_DIAGNOSTICS) {
          diagnosticState.truncated = true;
          break;
        }
        const rawRange = asObject(item.range);
        const normalized: Diagnostic = {
          engine: 'spyglass',
          authority: 'advisory',
          severity: severity(item.severity),
          code:
            typeof item.code === 'string' || typeof item.code === 'number'
              ? truncateUtf8(String(item.code), MAX_DIAGNOSTIC_CODE_BYTES)
              : 'spyglass.diagnostic',
          message: truncateUtf8(item.message, MAX_DIAGNOSTIC_MESSAGE_BYTES),
          path: relative,
          range: {
            start: position(rawRange?.start),
            end: position(rawRange?.end),
          },
        };
        const bytes = Buffer.byteLength(JSON.stringify(normalized), 'utf8');
        if (diagnosticState.bytes + bytes > MAX_SPYGLASS_DIAGNOSTIC_BYTES) {
          diagnosticState.truncated = true;
          break;
        }
        diagnostics.push(normalized);
        diagnosticState.bytes += bytes;
      }
    });

    const onAbort = (): void => {
      void connection.terminate().catch(() => undefined);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    try {
      const rootUri = pathToFileURL(packRoot).href;
      await connection.request('initialize', {
        processId: process.pid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: path.basename(packRoot) }],
        capabilities: {
          textDocument: { publishDiagnostics: { relatedInformation: true } },
          workspace: { workspaceFolders: true },
        },
        clientInfo: { name: 'packwright-mcp', version: '0.2.0' },
      });
      await connection.notify('initialized', {});
      const documents = await textDocuments(packRoot);
      let version = 1;
      for (const filename of documents) {
        if (signal?.aborted) throw new Error('Spyglass validation was cancelled.');
        await connection.notify('textDocument/didOpen', {
          textDocument: {
            uri: pathToFileURL(filename).href,
            languageId: languageId(filename),
            version,
            text: await readDocument(filename),
          },
        });
        version += 1;
      }

      const documentsOpenedAt = Date.now();
      lastDiagnosticAt = documentsOpenedAt;
      const deadline = documentsOpenedAt + 15_000;
      while (Date.now() < deadline) {
        if (signal?.aborted) throw new Error('Spyglass validation was cancelled.');
        if (
          Date.now() - documentsOpenedAt >= DIAGNOSTIC_MINIMUM_WAIT_MS &&
          Date.now() - lastDiagnosticAt >= DIAGNOSTIC_QUIET_PERIOD_MS
        ) {
          break;
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 100);
        });
      }
      await connection.request('shutdown', null, 5_000).catch(() => undefined);
      await connection.notify('exit').catch(() => undefined);
      if (diagnosticState.truncated) {
        diagnostics.push({
          engine: 'spyglass',
          authority: 'advisory',
          severity: 'information',
          code: 'spyglass.payload_truncated',
          message:
            'Additional Spyglass diagnostics were omitted because validator safety limits were reached.',
        });
      }
      return diagnostics;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      await connection.terminate();
    }
  }
}

export function spyglassUnavailableDiagnostic(reason?: string): Diagnostic {
  return {
    engine: 'spyglass',
    authority: 'advisory',
    severity: 'information',
    code: 'spyglass.setup_required',
    message: reason
      ? `External Spyglass validation was requested but is not ready: ${reason}. Structural validation still completed.`
      : `External Spyglass ${PINNED_SPYGLASS_VERSION} validation was requested but PACKWRIGHT_SPYGLASS_COMMAND is not configured; structural validation still completed.`,
  };
}
