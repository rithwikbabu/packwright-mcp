import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { PackwrightError } from './errors.js';

export interface WorkspaceOptions {
  readOnly?: boolean;
}

export interface ResolveOptions {
  mustExist?: boolean;
  allowRoot?: boolean;
  rejectSymlinks?: boolean;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function decodePath(value: string): string {
  let decoded = value;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      throw new PackwrightError('unsafe_path', 'Path contains malformed percent encoding.', {
        path: value,
      });
    }
    if (next === decoded) return decoded;
    decoded = next;
  }
  return decoded;
}

export class Workspace {
  readonly root: string;
  readonly readOnly: boolean;

  private constructor(root: string, options: WorkspaceOptions) {
    this.root = root;
    this.readOnly = options.readOnly ?? false;
  }

  static async open(root: string, options: WorkspaceOptions = {}): Promise<Workspace> {
    if (!root || !path.isAbsolute(root)) {
      throw new PackwrightError('invalid_workspace', 'Workspace root must be an absolute path.', {
        root,
      });
    }

    let info;
    try {
      info = await stat(root);
    } catch (error) {
      throw new PackwrightError('invalid_workspace', 'Workspace root does not exist.', {
        root,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (!info.isDirectory()) {
      throw new PackwrightError('invalid_workspace', 'Workspace root is not a directory.', {
        root,
      });
    }

    return new Workspace(await realpath(root), options);
  }

  normalize(relativePath: string, allowRoot = false): string {
    if (typeof relativePath !== 'string' || relativePath.includes('\0')) {
      throw new PackwrightError('unsafe_path', 'Path must be a NUL-free string.');
    }
    const decoded = decodePath(relativePath);
    if (
      path.isAbsolute(decoded) ||
      path.posix.isAbsolute(decoded) ||
      path.win32.isAbsolute(decoded) ||
      decoded.includes('\\')
    ) {
      throw new PackwrightError('unsafe_path', 'Only workspace-relative POSIX paths are allowed.', {
        path: relativePath,
      });
    }

    const withoutTrailingSlash = decoded.replace(/\/+$/u, '');
    const segments = withoutTrailingSlash === '' ? [] : withoutTrailingSlash.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new PackwrightError(
        'unsafe_path',
        'Path traversal and empty segments are not allowed.',
        {
          path: relativePath,
        },
      );
    }
    if (segments.length === 0 && !allowRoot) {
      throw new PackwrightError('unsafe_path', 'A path target is required.');
    }
    return segments.join('/');
  }

  async resolve(relativePath: string, options: ResolveOptions = {}): Promise<string> {
    const normalized = this.normalize(relativePath, options.allowRoot);
    const segments = normalized === '' ? [] : normalized.split('/');
    let current = this.root;

    for (const [index, segment] of segments.entries()) {
      current = path.join(current, segment);
      let info;
      try {
        info = await lstat(current);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') throw error;
        current = path.join(current, ...segments.slice(index + 1));
        break;
      }

      if (info.isSymbolicLink()) {
        if (options.rejectSymlinks) {
          throw new PackwrightError(
            'unsafe_path',
            'Symbolic links are not allowed for this operation.',
            {
              path: normalized,
            },
          );
        }
        const linked = await realpath(current);
        if (!isWithin(this.root, linked)) {
          throw new PackwrightError(
            'unsafe_path',
            'Path escapes the workspace through a symbolic link.',
            {
              path: normalized,
            },
          );
        }
        current = linked;
      }

      if (!isWithin(this.root, path.resolve(current))) {
        throw new PackwrightError('unsafe_path', 'Path escapes the workspace.', {
          path: normalized,
        });
      }
    }

    const absolute = path.resolve(current);
    if (!isWithin(this.root, absolute)) {
      throw new PackwrightError('unsafe_path', 'Path escapes the workspace.', {
        path: normalized,
      });
    }

    if (options.mustExist) {
      try {
        await lstat(absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new PackwrightError('not_found', 'Path does not exist.', {
            path: normalized,
          });
        }
        throw error;
      }
    }
    return absolute;
  }

  relative(absolutePath: string): string {
    if (!isWithin(this.root, path.resolve(absolutePath))) {
      throw new PackwrightError('unsafe_path', 'Absolute path is outside the workspace.');
    }
    return path.relative(this.root, absolutePath).split(path.sep).join('/');
  }

  assertWritable(): void {
    if (this.readOnly) {
      throw new PackwrightError('read_only', 'Workspace was opened in read-only mode.');
    }
  }

  async ensureDirectory(relativePath: string): Promise<string> {
    this.assertWritable();
    const normalized = this.normalize(relativePath, true);
    const target = await this.resolve(normalized, { allowRoot: true, rejectSymlinks: true });
    await mkdir(target, { recursive: true });
    return this.resolve(normalized, {
      allowRoot: true,
      mustExist: true,
      rejectSymlinks: true,
    });
  }
}
