import path from 'node:path';

import {
  isValidNamespace,
  isValidResourceId,
  isValidResourcePath,
  parseResourceId,
} from '../core/identifiers.js';
import { MAX_SCAN_BYTES, MAX_SCAN_FILES, MAX_TEXT_WRITE_BYTES } from '../core/limits.js';
import { MINECRAFT_26_2 } from '../core/version.js';
import { compareVisualStrings } from './compiler.js';
import { decodePng } from './png.js';
import {
  inlineItemPropertyParameters,
  validateItemProperty,
  validateSelectValues,
  type ItemPropertyKind,
} from './item-properties.js';
import type { VisualDiagnostic, VisualDiagnosticSeverity } from './visual-validation.js';

export interface ResourcePackSnapshotEntry {
  readonly path: string;
  readonly data: string | Uint8Array;
}

export interface ResourcePackSnapshotValidationOptions {
  /** Verified built-in model identifiers, usually sourced from the pinned client cache. */
  readonly recognizedBuiltInModels?: ReadonlySet<string> | undefined;
  /** Verified built-in texture identifiers, usually sourced from the pinned client cache. */
  readonly recognizedBuiltInTextures?: ReadonlySet<string> | undefined;
}

export interface ResourcePackSnapshotValidationResult {
  readonly ok: boolean;
  readonly diagnostics: readonly VisualDiagnostic[];
  readonly filesChecked: number;
  readonly jsonFilesChecked: number;
  readonly pngFilesChecked: number;
  readonly modelsChecked: number;
  readonly referencesChecked: number;
}

type JsonRecord = Record<string, unknown>;

interface ModelSnapshot {
  readonly id: string;
  readonly path: string;
  readonly parent?: string | undefined;
  readonly textures: ReadonlyMap<string, string>;
  readonly faceTextureVariables: ReadonlySet<string>;
  readonly textureReferences: Set<string>;
}

interface ResourceReference {
  readonly id: string;
  readonly path: string;
}

interface ParsedSnapshot {
  readonly diagnostics: VisualDiagnostic[];
  readonly paths: ReadonlyMap<string, Buffer>;
  readonly json: ReadonlyMap<string, unknown>;
  readonly textures: ReadonlyMap<string, string>;
  readonly filesChecked: number;
  readonly jsonFilesChecked: number;
  readonly pngFilesChecked: number;
}

interface ItemModelBudget {
  remaining: number;
}

const ITEM_MODEL_NODE_LIMIT = 4096;
const ITEM_MODEL_DEPTH_LIMIT = 64;
const MODEL_FACE_NAMES = new Set(['down', 'east', 'north', 'south', 'up', 'west']);
const MODEL_ROTATION_ANGLES = new Set(MINECRAFT_26_2.resourcePack.modelRules.rotationAngles);
const ITEM_MODEL_TYPES = new Set(MINECRAFT_26_2.resourcePack.itemModelTypes);
const KNOWN_MODEL_PARENTS = new Set(MINECRAFT_26_2.resourcePack.builtInModelParents);
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const UNVERIFIED_TEXTURE_VARIABLE = Symbol('unverified_texture_variable');
const CONDITION_FIELDS = new Set(['type', 'property', 'on_true', 'on_false']);
const SELECT_FIELDS = new Set(['type', 'property', 'cases', 'fallback']);
const RANGE_FIELDS = new Set(['type', 'property', 'scale', 'entries', 'fallback']);

function diagnostic(
  code: string,
  severity: VisualDiagnosticSeverity,
  message: string,
  location: Omit<VisualDiagnostic, 'engine' | 'authority' | 'severity' | 'code' | 'message'> = {},
): VisualDiagnostic {
  return {
    engine: 'packwright.visual',
    authority: 'structural',
    severity,
    code,
    message,
    ...location,
  };
}

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function safeSnapshotPath(value: string): boolean {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > 1024 ||
    value.includes('\\') ||
    value.includes(':') ||
    path.posix.isAbsolute(value) ||
    value.endsWith('/')
  ) {
    return false;
  }
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point !== undefined && (point <= 31 || point === 127)) return false;
  }
  return value
    .split('/')
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function bytes(value: ResourcePackSnapshotEntry['data']): Buffer | undefined {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value instanceof Uint8Array) return Buffer.from(value);
  return undefined;
}

function severityPriority(value: VisualDiagnosticSeverity): number {
  switch (value) {
    case 'error':
      return 0;
    case 'warning':
      return 1;
    case 'information':
      return 2;
  }
}

function compareDiagnostics(left: VisualDiagnostic, right: VisualDiagnostic): number {
  const severity = severityPriority(left.severity) - severityPriority(right.severity);
  if (severity !== 0) return severity;
  const byPath = compareVisualStrings(left.path ?? '', right.path ?? '');
  if (byPath !== 0) return byPath;
  const byCode = compareVisualStrings(left.code, right.code);
  return byCode !== 0 ? byCode : compareVisualStrings(left.message, right.message);
}

function parseSnapshot(entries: readonly ResourcePackSnapshotEntry[]): ParsedSnapshot {
  const diagnostics: VisualDiagnostic[] = [];
  const paths = new Map<string, Buffer>();
  const json = new Map<string, unknown>();
  const textures = new Map<string, string>();
  let totalBytes = 0;
  let jsonFilesChecked = 0;
  let pngFilesChecked = 0;

  if (entries.length > MAX_SCAN_FILES) {
    diagnostics.push(
      diagnostic(
        'visual.resourcepack.file_limit',
        'error',
        `Resource-pack snapshot exceeds the ${String(MAX_SCAN_FILES)}-file limit.`,
      ),
    );
  }
  const bounded = entries.slice(0, MAX_SCAN_FILES).map((entry, index) => ({ entry, index }));
  bounded.sort((left, right) => {
    const byPath = compareVisualStrings(left.entry.path, right.entry.path);
    return byPath !== 0 ? byPath : left.index - right.index;
  });

  for (const { entry } of bounded) {
    if (!safeSnapshotPath(entry.path)) {
      diagnostics.push(
        diagnostic(
          'visual.resourcepack.unsafe_path',
          'error',
          `Resource-pack snapshot contains an unsafe path: '${entry.path}'.`,
          { path: entry.path },
        ),
      );
      continue;
    }
    if (paths.has(entry.path)) {
      diagnostics.push(
        diagnostic(
          'visual.resourcepack.duplicate_path',
          'error',
          `Resource-pack path '${entry.path}' is duplicated.`,
          { path: entry.path },
        ),
      );
      continue;
    }
    const content = bytes(entry.data);
    if (content === undefined) {
      diagnostics.push(
        diagnostic(
          'visual.resourcepack.invalid_bytes',
          'error',
          `Resource-pack entry '${entry.path}' does not contain text or bytes.`,
          { path: entry.path },
        ),
      );
      continue;
    }
    totalBytes += content.length;
    if (totalBytes > MAX_SCAN_BYTES) {
      diagnostics.push(
        diagnostic(
          'visual.resourcepack.byte_limit',
          'error',
          'Resource-pack snapshot exceeds the 512 MiB uncompressed limit.',
          { path: entry.path },
        ),
      );
      break;
    }
    paths.set(entry.path, content);

    if (entry.path.endsWith('.json') || entry.path.endsWith('.mcmeta')) {
      jsonFilesChecked += 1;
      if (content.length > MAX_TEXT_WRITE_BYTES) {
        diagnostics.push(
          diagnostic(
            'visual.resourcepack.json_size',
            'error',
            `JSON resource '${entry.path}' exceeds the 4 MiB validation limit.`,
            { path: entry.path },
          ),
        );
      } else {
        try {
          const text = UTF8.decode(content);
          json.set(entry.path, JSON.parse(text) as unknown);
        } catch (error) {
          diagnostics.push(
            diagnostic(
              'visual.resourcepack.invalid_json',
              'error',
              `JSON resource '${entry.path}' is invalid: ${error instanceof Error ? error.message : String(error)}`,
              { path: entry.path },
            ),
          );
        }
      }
    }
    if (entry.path.endsWith('.png')) {
      pngFilesChecked += 1;
      try {
        decodePng(content);
      } catch (error) {
        diagnostics.push(
          diagnostic(
            'visual.resourcepack.invalid_png',
            'error',
            `PNG resource '${entry.path}' is invalid: ${error instanceof Error ? error.message : String(error)}`,
            { path: entry.path },
          ),
        );
      }
    }

    const location = assetLocation(entry.path, 'textures', '.png');
    if (location !== undefined) textures.set(location.id, entry.path);
  }
  return {
    diagnostics,
    paths,
    json,
    textures,
    filesChecked: paths.size,
    jsonFilesChecked,
    pngFilesChecked,
  };
}

function assetLocation(
  filename: string,
  directory: 'blockstates' | 'items' | 'models' | 'textures',
  extension: '.json' | '.png',
): { readonly id: string; readonly namespace: string; readonly resourcePath: string } | undefined {
  const segments = filename.split('/');
  if (
    segments[0] !== 'assets' ||
    segments[2] !== directory ||
    segments.length < 4 ||
    !filename.endsWith(extension)
  ) {
    return undefined;
  }
  const namespace = segments[1];
  const suffix = segments.slice(3).join('/');
  const resourcePath = suffix.slice(0, -extension.length);
  if (
    namespace === undefined ||
    !isValidNamespace(namespace) ||
    !isValidResourcePath(resourcePath)
  ) {
    return undefined;
  }
  return { id: `${namespace}:${resourcePath}`, namespace, resourcePath };
}

function resourceId(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const qualified = value.includes(':') ? value : `minecraft:${value}`;
  return isValidResourceId(qualified) ? qualified : undefined;
}

function numberVector(value: unknown, length: number): value is readonly number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
  );
}

function validatePackMetadata(
  value: unknown,
  diagnostics: VisualDiagnostic[],
  present: boolean,
): void {
  if (!present) {
    diagnostics.push(
      diagnostic(
        'visual.resourcepack.metadata_missing',
        'error',
        'Resource-pack snapshot must contain pack.mcmeta at its root.',
        { path: 'pack.mcmeta' },
      ),
    );
    return;
  }
  const root = record(value);
  const pack = record(root?.pack);
  if (root === undefined || pack === undefined) {
    diagnostics.push(
      diagnostic(
        'visual.resourcepack.metadata_schema',
        'error',
        'pack.mcmeta must contain a pack object.',
        { path: 'pack.mcmeta' },
      ),
    );
    return;
  }
  for (const field of ['min_format', 'max_format'] as const) {
    const format = pack[field];
    if (!numberVector(format, 2) || format[0] !== 88 || format[1] !== 0) {
      diagnostics.push(
        diagnostic(
          'visual.resourcepack.metadata_format',
          'error',
          `pack.mcmeta ${field} must be exactly [88, 0] for Minecraft 26.2.`,
          { path: 'pack.mcmeta' },
        ),
      );
    }
  }
}

function validateElement(
  value: unknown,
  model: ModelSnapshot,
  index: number,
  diagnostics: VisualDiagnostic[],
  faceVariables: Set<string>,
  textureReferences: Set<string>,
): void {
  const element = record(value);
  const location = `${model.path}#elements[${String(index)}]`;
  if (element === undefined) {
    diagnostics.push(
      diagnostic('visual.resourcepack.model_element', 'error', 'Model element must be an object.', {
        target: model.id,
        path: model.path,
      }),
    );
    return;
  }
  for (const field of ['from', 'to'] as const) {
    const vector = element[field];
    if (!numberVector(vector, 3)) {
      diagnostics.push(
        diagnostic(
          'visual.resourcepack.model_bounds',
          'error',
          `${location}.${field} must be a finite three-number vector.`,
          { target: model.id, path: model.path },
        ),
      );
    } else if (vector.some((coordinate) => coordinate < -16 || coordinate > 32)) {
      diagnostics.push(
        diagnostic(
          'visual.resourcepack.model_bounds',
          'error',
          `${location}.${field} exceeds the Minecraft 26.2 model bounds of -16 through 32.`,
          { target: model.id, path: model.path },
        ),
      );
    }
  }
  if (element.rotation !== undefined) {
    const rotation = record(element.rotation);
    if (
      rotation === undefined ||
      !numberVector(rotation.origin, 3) ||
      !MINECRAFT_26_2.resourcePack.modelRules.rotationAxes.includes(
        rotation.axis as 'x' | 'y' | 'z',
      ) ||
      typeof rotation.angle !== 'number' ||
      !MODEL_ROTATION_ANGLES.has(rotation.angle)
    ) {
      diagnostics.push(
        diagnostic(
          'visual.resourcepack.model_rotation',
          'error',
          `${location}.rotation does not satisfy the Minecraft 26.2 element-rotation rules.`,
          { target: model.id, path: model.path },
        ),
      );
    }
  }
  const faces = record(element.faces);
  if (faces === undefined) {
    diagnostics.push(
      diagnostic(
        'visual.resourcepack.model_faces',
        'error',
        `${location}.faces must be an object.`,
        { target: model.id, path: model.path },
      ),
    );
    return;
  }
  for (const [faceName, faceValue] of Object.entries(faces)) {
    const face = record(faceValue);
    if (!MODEL_FACE_NAMES.has(faceName) || face === undefined || typeof face.texture !== 'string') {
      diagnostics.push(
        diagnostic(
          'visual.resourcepack.model_face',
          'error',
          `${location}.faces.${faceName} is not a valid model face.`,
          { target: model.id, path: model.path },
        ),
      );
      continue;
    }
    if (face.texture.startsWith('#')) {
      faceVariables.add(face.texture.slice(1));
    } else {
      const reference = resourceId(face.texture);
      if (reference === undefined) {
        diagnostics.push(
          diagnostic(
            'visual.resourcepack.texture_reference',
            'error',
            `Model face '${faceName}' has an invalid texture reference '${face.texture}'.`,
            { target: model.id, path: model.path },
          ),
        );
      } else {
        textureReferences.add(reference);
      }
    }
    if (face.uv !== undefined && !numberVector(face.uv, 4)) {
      diagnostics.push(
        diagnostic(
          'visual.resourcepack.model_uv',
          'error',
          `${location}.faces.${faceName}.uv must contain four finite numbers.`,
          { target: model.id, path: model.path },
        ),
      );
    }
    if (face.rotation !== undefined && ![0, 90, 180, 270].includes(face.rotation as number)) {
      diagnostics.push(
        diagnostic(
          'visual.resourcepack.model_face_rotation',
          'error',
          `${location}.faces.${faceName}.rotation must be 0, 90, 180, or 270.`,
          { target: model.id, path: model.path },
        ),
      );
    }
  }
}

function parseModel(
  id: string,
  filename: string,
  value: unknown,
  diagnostics: VisualDiagnostic[],
): ModelSnapshot | undefined {
  const object = record(value);
  if (object === undefined) {
    diagnostics.push(
      diagnostic(
        'visual.resourcepack.model_schema',
        'error',
        `Model '${id}' must be a JSON object.`,
        { target: id, path: filename },
      ),
    );
    return undefined;
  }
  let parent: string | undefined;
  if (object.parent !== undefined) {
    parent = resourceId(object.parent);
    if (parent === undefined) {
      diagnostics.push(
        diagnostic(
          'visual.resourcepack.model_parent',
          'error',
          `Model '${id}' has an invalid parent reference.`,
          { target: id, path: filename },
        ),
      );
    }
  }
  const textureValues = new Map<string, string>();
  const textureReferences = new Set<string>();
  if (object.textures !== undefined) {
    const textures = record(object.textures);
    if (textures === undefined) {
      diagnostics.push(
        diagnostic(
          'visual.resourcepack.model_textures',
          'error',
          `Model '${id}' textures must be an object.`,
          { target: id, path: filename },
        ),
      );
    } else {
      for (const [key, texture] of Object.entries(textures)) {
        if (key.length === 0 || typeof texture !== 'string' || texture.length === 0) {
          diagnostics.push(
            diagnostic(
              'visual.resourcepack.model_texture_variable',
              'error',
              `Model '${id}' contains an invalid texture variable '${key}'.`,
              { target: id, path: filename },
            ),
          );
          continue;
        }
        textureValues.set(key, texture);
        if (!texture.startsWith('#')) {
          const reference = resourceId(texture);
          if (reference === undefined) {
            diagnostics.push(
              diagnostic(
                'visual.resourcepack.texture_reference',
                'error',
                `Model '${id}' has an invalid texture reference '${texture}'.`,
                { target: id, path: filename },
              ),
            );
          } else {
            textureReferences.add(reference);
          }
        }
      }
    }
  }
  const faceTextureVariables = new Set<string>();
  const snapshot: ModelSnapshot = {
    id,
    path: filename,
    ...(parent === undefined ? {} : { parent }),
    textures: textureValues,
    faceTextureVariables,
    textureReferences,
  };
  if (object.elements !== undefined) {
    if (!Array.isArray(object.elements)) {
      diagnostics.push(
        diagnostic(
          'visual.resourcepack.model_elements',
          'error',
          `Model '${id}' elements must be an array.`,
          { target: id, path: filename },
        ),
      );
    } else {
      object.elements.forEach((element, index) =>
        validateElement(
          element,
          snapshot,
          index,
          diagnostics,
          faceTextureVariables,
          textureReferences,
        ),
      );
    }
  }
  if (object.parent === undefined && object.elements === undefined) {
    diagnostics.push(
      diagnostic(
        'visual.resourcepack.model_empty',
        'warning',
        `Model '${id}' has neither a parent nor elements; its rendering is unverified.`,
        { target: id, path: filename },
      ),
    );
  }
  if (object.gui_light !== undefined && !['front', 'side'].includes(object.gui_light as string)) {
    diagnostics.push(
      diagnostic(
        'visual.resourcepack.model_gui_light',
        'error',
        `Model '${id}' gui_light must be 'front' or 'side'.`,
        { target: id, path: filename },
      ),
    );
  }
  return snapshot;
}

function visitItemModel(
  value: unknown,
  filename: string,
  jsonPath: string,
  references: ResourceReference[],
  diagnostics: VisualDiagnostic[],
  budget: ItemModelBudget,
  depth = 0,
): void {
  if (depth > ITEM_MODEL_DEPTH_LIMIT || budget.remaining <= 0) {
    diagnostics.push(
      diagnostic(
        'visual.resourcepack.item_model_limit',
        'error',
        `Item-definition model tree at '${jsonPath}' exceeds validation limits.`,
        { path: filename },
      ),
    );
    return;
  }
  budget.remaining -= 1;
  const node = record(value);
  if (node === undefined || typeof node.type !== 'string' || !ITEM_MODEL_TYPES.has(node.type)) {
    diagnostics.push(
      diagnostic(
        'visual.resourcepack.item_model_type',
        'error',
        `Item-definition node '${jsonPath}' has an unsupported model type.`,
        { path: filename },
      ),
    );
    return;
  }
  const visit = (child: unknown, suffix: string): void =>
    visitItemModel(
      child,
      filename,
      `${jsonPath}.${suffix}`,
      references,
      diagnostics,
      budget,
      depth + 1,
    );
  const validateProperty = (kind: ItemPropertyKind, reserved: ReadonlySet<string>): void => {
    if (typeof node.property !== 'string') {
      diagnostics.push(
        diagnostic(
          'visual.resourcepack.item_property',
          'error',
          `Item-definition node '${jsonPath}' must declare a supported ${kind} property.`,
          { path: filename },
        ),
      );
      return;
    }
    const parameters = inlineItemPropertyParameters(node, reserved);
    for (const message of validateItemProperty(kind, node.property, parameters)) {
      diagnostics.push(
        diagnostic('visual.resourcepack.item_property', 'error', message, { path: filename }),
      );
    }
  };
  switch (node.type) {
    case 'minecraft:model': {
      const reference = resourceId(node.model);
      if (reference === undefined) {
        diagnostics.push(
          diagnostic(
            'visual.resourcepack.item_model_reference',
            'error',
            `Item-definition node '${jsonPath}' has an invalid model reference.`,
            { path: filename },
          ),
        );
      } else {
        references.push({ id: reference, path: filename });
      }
      break;
    }
    case 'minecraft:condition':
      validateProperty('condition', CONDITION_FIELDS);
      visit(node.on_true, 'on_true');
      visit(node.on_false, 'on_false');
      break;
    case 'minecraft:select': {
      validateProperty('select', SELECT_FIELDS);
      if (!Array.isArray(node.cases)) {
        diagnostics.push(
          diagnostic(
            'visual.resourcepack.item_model_cases',
            'error',
            `Item-definition node '${jsonPath}.cases' must be an array.`,
            { path: filename },
          ),
        );
      } else {
        node.cases.forEach((entry, index) => {
          const item = record(entry);
          const matches =
            typeof item?.when === 'string'
              ? [item.when]
              : Array.isArray(item?.when) && item.when.every((match) => typeof match === 'string')
                ? item.when
                : undefined;
          if (matches === undefined || matches.length === 0) {
            diagnostics.push(
              diagnostic(
                'visual.resourcepack.item_model_case',
                'error',
                `Item-definition case '${jsonPath}.cases[${String(index)}]' has an invalid when value.`,
                { path: filename },
              ),
            );
          } else if (typeof node.property === 'string') {
            for (const message of validateSelectValues(node.property, matches)) {
              diagnostics.push(
                diagnostic('visual.resourcepack.item_model_case', 'error', message, {
                  path: filename,
                }),
              );
            }
          }
          visit(item?.model, `cases[${String(index)}].model`);
        });
      }
      if (node.fallback !== undefined) visit(node.fallback, 'fallback');
      break;
    }
    case 'minecraft:range_dispatch': {
      validateProperty('range_dispatch', RANGE_FIELDS);
      if (!Array.isArray(node.entries)) {
        diagnostics.push(
          diagnostic(
            'visual.resourcepack.item_model_entries',
            'error',
            `Item-definition node '${jsonPath}.entries' must be an array.`,
            { path: filename },
          ),
        );
      } else {
        node.entries.forEach((entry, index) => {
          const item = record(entry);
          if (typeof item?.threshold !== 'number' || !Number.isFinite(item.threshold)) {
            diagnostics.push(
              diagnostic(
                'visual.resourcepack.item_model_threshold',
                'error',
                `Item-definition range entry '${jsonPath}.entries[${String(index)}]' has an invalid threshold.`,
                { path: filename },
              ),
            );
          }
          visit(item?.model, `entries[${String(index)}].model`);
        });
      }
      if (node.fallback !== undefined) visit(node.fallback, 'fallback');
      break;
    }
    case 'minecraft:composite':
      if (!Array.isArray(node.models) || node.models.length === 0) {
        diagnostics.push(
          diagnostic(
            'visual.resourcepack.item_model_composite',
            'error',
            `Item-definition node '${jsonPath}.models' must be a non-empty array.`,
            { path: filename },
          ),
        );
      } else {
        node.models.forEach((child, index) => visit(child, `models[${String(index)}]`));
      }
      break;
    case 'minecraft:special': {
      const base = resourceId(node.base);
      if (base !== undefined) references.push({ id: base, path: filename });
      diagnostics.push(
        diagnostic(
          'visual.resourcepack.item_model_unverified',
          'warning',
          `Special item-model node '${jsonPath}' is syntax-checked but not fully validated by the first-release validator.`,
          { path: filename },
        ),
      );
      break;
    }
    case 'minecraft:bundle/selected_item':
      diagnostics.push(
        diagnostic(
          'visual.resourcepack.item_model_unverified',
          'warning',
          `Bundle item-model node '${jsonPath}' is not fully validated by the first-release validator.`,
          { path: filename },
        ),
      );
      break;
    case 'minecraft:empty':
      break;
  }
}

function parseItemDefinition(
  id: string,
  filename: string,
  value: unknown,
  diagnostics: VisualDiagnostic[],
): ResourceReference[] {
  const model = record(value)?.model;
  if (model === undefined) {
    diagnostics.push(
      diagnostic(
        'visual.resourcepack.item_definition_schema',
        'error',
        `Item definition '${id}' must contain a model object.`,
        { target: id, path: filename },
      ),
    );
    return [];
  }
  const references: ResourceReference[] = [];
  visitItemModel(model, filename, 'model', references, diagnostics, {
    remaining: ITEM_MODEL_NODE_LIMIT,
  });
  return references;
}

function parseBlockstateVariant(
  value: unknown,
  filename: string,
  jsonPath: string,
  references: ResourceReference[],
  diagnostics: VisualDiagnostic[],
): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      diagnostics.push(
        diagnostic(
          'visual.resourcepack.blockstate_variant',
          'error',
          `Blockstate '${jsonPath}' must not be an empty variant array.`,
          { path: filename },
        ),
      );
    }
    value.forEach((entry, index) =>
      parseBlockstateVariant(
        entry,
        filename,
        `${jsonPath}[${String(index)}]`,
        references,
        diagnostics,
      ),
    );
    return;
  }
  const variant = record(value);
  const model = resourceId(variant?.model);
  if (variant === undefined || model === undefined) {
    diagnostics.push(
      diagnostic(
        'visual.resourcepack.blockstate_model',
        'error',
        `Blockstate variant '${jsonPath}' must contain a valid model reference.`,
        { path: filename },
      ),
    );
    return;
  }
  references.push({ id: model, path: filename });
}

function parseBlockstate(
  id: string,
  filename: string,
  value: unknown,
  diagnostics: VisualDiagnostic[],
): ResourceReference[] {
  const object = record(value);
  if (object === undefined) {
    diagnostics.push(
      diagnostic(
        'visual.resourcepack.blockstate_schema',
        'error',
        `Blockstate '${id}' must be a JSON object.`,
        { target: id, path: filename },
      ),
    );
    return [];
  }
  const references: ResourceReference[] = [];
  const variants = record(object.variants);
  if (variants !== undefined) {
    for (const [key, variant] of Object.entries(variants)) {
      parseBlockstateVariant(variant, filename, `variants.${key}`, references, diagnostics);
    }
  }
  if (object.multipart !== undefined) {
    if (!Array.isArray(object.multipart)) {
      diagnostics.push(
        diagnostic(
          'visual.resourcepack.blockstate_multipart',
          'error',
          `Blockstate '${id}' multipart must be an array.`,
          { target: id, path: filename },
        ),
      );
    } else {
      object.multipart.forEach((entry, index) => {
        const part = record(entry);
        parseBlockstateVariant(
          part?.apply,
          filename,
          `multipart[${String(index)}].apply`,
          references,
          diagnostics,
        );
      });
    }
  }
  if (variants === undefined && object.multipart === undefined) {
    diagnostics.push(
      diagnostic(
        'visual.resourcepack.blockstate_schema',
        'error',
        `Blockstate '${id}' must contain variants or multipart.`,
        { target: id, path: filename },
      ),
    );
  }
  return references;
}

function resolveTextureVariable(
  model: ModelSnapshot,
  variable: string,
  models: ReadonlyMap<string, ModelSnapshot>,
  diagnostics: VisualDiagnostic[],
  stack: Set<string>,
): string | typeof UNVERIFIED_TEXTURE_VARIABLE | undefined {
  const token = `${model.id}#${variable}`;
  if (stack.has(token)) {
    diagnostics.push(
      diagnostic(
        'visual.resourcepack.texture_variable_cycle',
        'error',
        `Model '${model.id}' contains a cyclic texture variable at '#${variable}'.`,
        { target: model.id, path: model.path },
      ),
    );
    return undefined;
  }
  stack.add(token);
  const value = model.textures.get(variable);
  if (value !== undefined) {
    if (value.startsWith('#')) {
      return resolveTextureVariable(model, value.slice(1), models, diagnostics, stack);
    }
    return resourceId(value);
  }
  const parent = model.parent === undefined ? undefined : models.get(model.parent);
  if (parent !== undefined) {
    return resolveTextureVariable(parent, variable, models, diagnostics, stack);
  }
  return model.parent === undefined ? undefined : UNVERIFIED_TEXTURE_VARIABLE;
}

function detectParentCycles(
  models: ReadonlyMap<string, ModelSnapshot>,
  diagnostics: VisualDiagnostic[],
): void {
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];
  const reported = new Set<string>();
  const visit = (id: string): void => {
    if (active.has(id)) {
      const start = stack.indexOf(id);
      const cycle = [...stack.slice(start), id];
      const signature = cycle.join('\0');
      if (!reported.has(signature)) {
        reported.add(signature);
        diagnostics.push(
          diagnostic(
            'visual.resourcepack.model_parent_cycle',
            'error',
            `Model parent cycle detected: ${cycle.join(' -> ')}.`,
            { target: id, path: models.get(id)?.path },
          ),
        );
      }
      return;
    }
    if (visited.has(id)) return;
    visited.add(id);
    active.add(id);
    stack.push(id);
    const parent = models.get(id)?.parent;
    if (parent !== undefined && models.has(parent)) visit(parent);
    stack.pop();
    active.delete(id);
  };
  for (const id of [...models.keys()].sort(compareVisualStrings)) visit(id);
}

function referenceDiagnostic(
  kind: 'model' | 'texture',
  reference: ResourceReference,
  present: boolean,
  recognized: ReadonlySet<string>,
): VisualDiagnostic | undefined {
  if (present || recognized.has(reference.id)) return undefined;
  const namespace = parseResourceId(reference.id).namespace;
  if (namespace === 'minecraft') {
    return diagnostic(
      `visual.resourcepack.${kind}_unverified_builtin`,
      'warning',
      `Built-in ${kind} reference '${reference.id}' is not verified by this snapshot.`,
      {
        target: reference.id,
        path: reference.path,
        suggestedFix:
          'Validate the reference against the manifest-hashed Minecraft 26.2 client-asset cache.',
      },
    );
  }
  return diagnostic(
    `visual.resourcepack.missing_${kind}`,
    'error',
    `Referenced ${kind} '${reference.id}' is missing from the resource-pack snapshot.`,
    { target: reference.id, path: reference.path },
  );
}

function resourceDirectoryWarning(filename: string, diagnostics: VisualDiagnostic[]): void {
  const directory = filename.split('/')[2];
  if (
    filename === 'pack.mcmeta' ||
    directory === 'models' ||
    directory === 'items' ||
    directory === 'blockstates'
  ) {
    return;
  }
  if (filename.endsWith('.png.mcmeta')) {
    diagnostics.push(
      diagnostic(
        'visual.resourcepack.texture_metadata_unverified',
        'information',
        `Texture metadata '${filename}' is syntax-checked but its animation schema is not fully validated.`,
        { path: filename },
      ),
    );
    return;
  }
  if (filename.startsWith('assets/') && filename.endsWith('.json')) {
    diagnostics.push(
      diagnostic(
        'visual.resourcepack.schema_unverified',
        'information',
        `JSON syntax for '${filename}' is valid, but its resource-specific schema is outside the first-release item/block validator.`,
        { path: filename },
      ),
    );
  }
}

/**
 * Validate an immutable Minecraft 26.2 resource-pack snapshot without reading the filesystem.
 * The first-release reference graph covers item definitions, blockstates, block/item models, and
 * PNG textures. Other JSON resources are syntax-checked and explicitly reported as unverified.
 */
export function validateResourcePackSnapshot(
  entries: readonly ResourcePackSnapshotEntry[],
  options: ResourcePackSnapshotValidationOptions = {},
): ResourcePackSnapshotValidationResult {
  const snapshot = parseSnapshot(entries);
  const diagnostics = [...snapshot.diagnostics];
  validatePackMetadata(
    snapshot.json.get('pack.mcmeta'),
    diagnostics,
    snapshot.paths.has('pack.mcmeta'),
  );

  const models = new Map<string, ModelSnapshot>();
  const modelRoots: ResourceReference[] = [];
  for (const [filename, value] of [...snapshot.json.entries()].sort((left, right) =>
    compareVisualStrings(left[0], right[0]),
  )) {
    const modelLocation = assetLocation(filename, 'models', '.json');
    const itemLocation = assetLocation(filename, 'items', '.json');
    const blockstateLocation = assetLocation(filename, 'blockstates', '.json');
    if (modelLocation !== undefined) {
      const model = parseModel(modelLocation.id, filename, value, diagnostics);
      if (model !== undefined) models.set(model.id, model);
    } else if (itemLocation !== undefined) {
      modelRoots.push(...parseItemDefinition(itemLocation.id, filename, value, diagnostics));
    } else if (blockstateLocation !== undefined) {
      modelRoots.push(...parseBlockstate(blockstateLocation.id, filename, value, diagnostics));
    }
    resourceDirectoryWarning(filename, diagnostics);
  }

  for (const filename of snapshot.paths.keys()) {
    const segments = filename.split('/');
    const directory = segments[0] === 'assets' ? segments[2] : undefined;
    if (
      segments[0] === 'assets' &&
      segments.length >= 3 &&
      (segments[1] === undefined || !isValidNamespace(segments[1]))
    ) {
      diagnostics.push(
        diagnostic(
          'visual.resourcepack.asset_namespace',
          'error',
          `Asset path '${filename}' contains an invalid namespace.`,
          { path: filename },
        ),
      );
    }
    if (
      (directory === 'models' || directory === 'items' || directory === 'blockstates') &&
      !filename.endsWith('.json')
    ) {
      diagnostics.push(
        diagnostic(
          'visual.resourcepack.resource_extension',
          'error',
          `Resource '${filename}' must use the .json extension.`,
          { path: filename },
        ),
      );
    }
    if (
      directory === 'textures' &&
      !filename.endsWith('.png') &&
      !filename.endsWith('.png.mcmeta')
    ) {
      diagnostics.push(
        diagnostic(
          'visual.resourcepack.resource_extension',
          'error',
          `Texture resource '${filename}' must be PNG or PNG metadata.`,
          { path: filename },
        ),
      );
    }
    if (
      directory === 'models' &&
      filename.endsWith('.json') &&
      assetLocation(filename, 'models', '.json') === undefined
    ) {
      diagnostics.push(
        diagnostic(
          'visual.resourcepack.asset_identifier',
          'error',
          `Model path '${filename}' does not form a valid resource identifier.`,
          { path: filename },
        ),
      );
    }
    if (
      directory === 'items' &&
      filename.endsWith('.json') &&
      assetLocation(filename, 'items', '.json') === undefined
    ) {
      diagnostics.push(
        diagnostic(
          'visual.resourcepack.asset_identifier',
          'error',
          `Item-definition path '${filename}' does not form a valid resource identifier.`,
          { path: filename },
        ),
      );
    }
    if (
      directory === 'blockstates' &&
      filename.endsWith('.json') &&
      assetLocation(filename, 'blockstates', '.json') === undefined
    ) {
      diagnostics.push(
        diagnostic(
          'visual.resourcepack.asset_identifier',
          'error',
          `Blockstate path '${filename}' does not form a valid resource identifier.`,
          { path: filename },
        ),
      );
    }
    if (
      directory === 'textures' &&
      filename.endsWith('.png') &&
      assetLocation(filename, 'textures', '.png') === undefined
    ) {
      diagnostics.push(
        diagnostic(
          'visual.resourcepack.asset_identifier',
          'error',
          `Texture path '${filename}' does not form a valid resource identifier.`,
          { path: filename },
        ),
      );
    }
  }

  detectParentCycles(models, diagnostics);
  for (const model of models.values()) {
    for (const variable of new Set([
      ...model.faceTextureVariables,
      ...[...model.textures.values()]
        .filter((value) => value.startsWith('#'))
        .map((value) => value.slice(1)),
    ])) {
      const resolved = resolveTextureVariable(model, variable, models, diagnostics, new Set());
      if (resolved === UNVERIFIED_TEXTURE_VARIABLE) {
        diagnostics.push(
          diagnostic(
            'visual.resourcepack.texture_variable_unverified',
            'warning',
            `Texture variable '#${variable}' in model '${model.id}' may be supplied by an unverified built-in parent.`,
            { target: model.id, path: model.path },
          ),
        );
      } else if (resolved === undefined) {
        diagnostics.push(
          diagnostic(
            'visual.resourcepack.texture_variable_missing',
            'error',
            `Texture variable '#${variable}' in model '${model.id}' cannot be resolved.`,
            { target: model.id, path: model.path },
          ),
        );
      } else {
        model.textureReferences.add(resolved);
      }
    }
  }

  const recognizedModels = new Set([
    ...KNOWN_MODEL_PARENTS,
    ...(options.recognizedBuiltInModels ?? []),
  ]);
  const recognizedTextures = new Set(options.recognizedBuiltInTextures ?? []);
  const parentReferences = [...models.values()]
    .filter(
      (model): model is ModelSnapshot & { readonly parent: string } => model.parent !== undefined,
    )
    .map((model) => ({ id: model.parent, path: model.path }));
  let referencesChecked = 0;
  for (const reference of [...modelRoots, ...parentReferences]) {
    referencesChecked += 1;
    const issue = referenceDiagnostic(
      'model',
      reference,
      models.has(reference.id),
      recognizedModels,
    );
    if (issue !== undefined) diagnostics.push(issue);
  }
  for (const model of models.values()) {
    for (const id of model.textureReferences) {
      referencesChecked += 1;
      const issue = referenceDiagnostic(
        'texture',
        { id, path: model.path },
        snapshot.textures.has(id),
        recognizedTextures,
      );
      if (issue !== undefined) diagnostics.push(issue);
    }
  }

  const reachableModels = new Set<string>();
  const reachableTextures = new Set<string>();
  const pending = modelRoots.map((reference) => reference.id).filter((id) => models.has(id));
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || reachableModels.has(id)) continue;
    reachableModels.add(id);
    const model = models.get(id);
    if (model === undefined) continue;
    if (model.parent !== undefined && models.has(model.parent)) pending.push(model.parent);
    for (const texture of model.textureReferences) {
      if (snapshot.textures.has(texture)) reachableTextures.add(texture);
    }
  }
  for (const model of models.values()) {
    if (!reachableModels.has(model.id)) {
      diagnostics.push(
        diagnostic(
          'visual.resourcepack.orphan_model',
          'warning',
          `Model '${model.id}' is not reachable from an item definition or blockstate in this snapshot.`,
          {
            target: model.id,
            path: model.path,
            suggestedFix:
              'Remove the model or confirm that another supported client resource references it.',
          },
        ),
      );
    }
  }
  for (const [id, filename] of snapshot.textures) {
    const resourcePath = parseResourceId(id).path;
    if (
      (resourcePath.startsWith('item/') || resourcePath.startsWith('block/')) &&
      !reachableTextures.has(id)
    ) {
      diagnostics.push(
        diagnostic(
          'visual.resourcepack.orphan_texture',
          'warning',
          `Texture '${id}' is not reachable from a validated item or block model.`,
          {
            target: id,
            path: filename,
            suggestedFix:
              'Remove the texture or confirm that an out-of-scope client resource uses it.',
          },
        ),
      );
    }
  }

  const normalized = diagnostics.sort(compareDiagnostics);
  return {
    ok: !normalized.some((entry) => entry.severity === 'error'),
    diagnostics: normalized,
    filesChecked: snapshot.filesChecked,
    jsonFilesChecked: snapshot.jsonFilesChecked,
    pngFilesChecked: snapshot.pngFilesChecked,
    modelsChecked: models.size,
    referencesChecked,
  };
}
