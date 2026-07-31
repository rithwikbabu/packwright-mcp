import { sha256Buffer } from '../core/hash.js';
import { parseResourceId } from '../core/identifiers.js';
import {
  DISPLAY_CONTEXTS,
  parseModelSpec,
  type DisplayContext,
  type DisplayTransform,
  type FaceUv,
  type ItemState,
  type ModelPart,
  type ModelSpec,
} from './model-spec.js';

export const VISUAL_MINECRAFT_VERSION = '26.2' as const;
export const RESOURCE_PACK_FORMAT_26_2 = [88, 0] as const;

/** Locale-independent ordering for content-addressed visual artifacts. */
export function compareVisualStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export type CompiledVisualFileRole = 'item_definition' | 'model';

export interface CompiledVisualFile {
  readonly path: string;
  readonly content: string;
  readonly mediaType: 'application/json';
  readonly sha256: string;
  readonly role: CompiledVisualFileRole;
  readonly resourceId: string;
}

export interface TextureRequirement {
  readonly materialId: string;
  readonly resourceId: string;
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly tintIndex?: number | undefined;
  readonly color?: string | undefined;
  readonly emissive: boolean;
  readonly transparent: boolean;
  readonly external: boolean;
}

export type ModelFace = 'down' | 'up' | 'north' | 'south' | 'west' | 'east';

export interface UvAssignment {
  readonly partId: string;
  readonly materialId: string;
  readonly face: ModelFace;
  /** Minecraft model UV coordinates, whose full texture extent is 0..16. */
  readonly uv: readonly [number, number, number, number];
  /** Exact source-pixel bounds before conversion to model UV coordinates. */
  readonly pixelBounds: readonly [number, number, number, number];
  readonly automatic: boolean;
}

export interface CompiledGeometryFace {
  readonly uv: UvAssignment['uv'];
  readonly rotation?: FaceUv['rotation'] | undefined;
  readonly tintIndex?: number | undefined;
}

export interface CompiledGeometryRotation {
  readonly axis: NonNullable<ModelPart['rotation']>['axis'];
  readonly angle: NonNullable<ModelPart['rotation']>['angle'];
  readonly pivot: NonNullable<ModelPart['rotation']>['pivot'];
  readonly rescale: boolean;
}

export interface CompiledGeometryElement {
  readonly partId: string;
  readonly shape: ModelPart['shape'];
  readonly from: ModelPart['from'];
  readonly to: ModelPart['to'];
  readonly materialId: string;
  readonly rotation?: CompiledGeometryRotation | undefined;
  readonly shade: boolean;
  readonly faces: Readonly<Partial<Record<ModelFace, CompiledGeometryFace>>>;
}

export interface CompiledItemAsset {
  readonly kind: 'item';
  readonly minecraftVersion: typeof VISUAL_MINECRAFT_VERSION;
  readonly resourcePackFormat: typeof RESOURCE_PACK_FORMAT_26_2;
  readonly spec: ModelSpec;
  readonly itemDefinitionResourceId: string;
  readonly modelResourceId: string;
  readonly parentModelResourceId: 'minecraft:item/generated' | 'minecraft:item/handheld';
  readonly files: readonly CompiledVisualFile[];
  readonly textures: readonly TextureRequirement[];
  readonly uvLayout: readonly UvAssignment[];
  /** Canonical geometry resolved from the same data serialized into the model JSON. */
  readonly geometry: readonly CompiledGeometryElement[];
  readonly externalModelReferences: readonly string[];
}

export interface ItemBindingProposal {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly strategy: 'minecraft:item_model';
  readonly capability: 'native';
  readonly logicalItem: string;
  readonly carrierItem: string;
  readonly component: Readonly<{
    id: 'minecraft:item_model';
    value: string;
  }>;
  readonly itemStack: Readonly<{
    id: string;
    count: 1;
    components: Readonly<Record<'minecraft:item_model', string>>;
  }>;
  readonly giveCommand: string;
  readonly itemDefinitionResourceId: string;
  readonly requiredFiles: readonly string[];
}

export interface BindingStrategy<TProposal> {
  readonly id: string;
  readonly targetKind: ModelSpec['targetKind'];
  propose(spec: ModelSpec, compiled: CompiledItemAsset, carrierItem?: string): TProposal;
}

const FACE_ORDER: readonly ModelFace[] = ['down', 'up', 'north', 'south', 'west', 'east'];

const DISPLAY_PRESETS: Readonly<
  Record<ModelSpec['displayPreset'], Readonly<Partial<Record<DisplayContext, DisplayTransform>>>>
> = Object.freeze({
  generated: Object.freeze({
    gui: transform([0, 0, 0], [0, 0, 0], [1, 1, 1]),
    ground: transform([0, 0, 0], [0, 2, 0], [0.5, 0.5, 0.5]),
    fixed: transform([0, 180, 0], [0, 0, 0], [0.5, 0.5, 0.5]),
  }),
  handheld: Object.freeze({
    thirdperson_righthand: transform([0, -90, 55], [0, 4, 0.5], [0.85, 0.85, 0.85]),
    thirdperson_lefthand: transform([0, 90, -55], [0, 4, 0.5], [0.85, 0.85, 0.85]),
    firstperson_righthand: transform([0, -90, 25], [1.13, 3.2, 1.13], [0.68, 0.68, 0.68]),
    firstperson_lefthand: transform([0, 90, -25], [1.13, 3.2, 1.13], [0.68, 0.68, 0.68]),
    gui: transform([30, 225, 0], [0, 0, 0], [0.625, 0.625, 0.625]),
    head: transform([0, 180, 0], [0, 13, 7], [1, 1, 1]),
    ground: transform([0, 0, 0], [0, 2, 0], [0.5, 0.5, 0.5]),
    fixed: transform([0, 180, 0], [0, 0, 0], [0.5, 0.5, 0.5]),
  }),
  handheld_3d: Object.freeze({
    thirdperson_righthand: transform([0, -90, 55], [0, 4, 0.5], [0.85, 0.85, 0.85]),
    thirdperson_lefthand: transform([0, 90, -55], [0, 4, 0.5], [0.85, 0.85, 0.85]),
    firstperson_righthand: transform([0, -90, 25], [1.13, 3.2, 1.13], [0.68, 0.68, 0.68]),
    firstperson_lefthand: transform([0, 90, -25], [1.13, 3.2, 1.13], [0.68, 0.68, 0.68]),
    gui: transform([30, 225, 0], [0, 0, 0], [0.625, 0.625, 0.625]),
    head: transform([0, 180, 0], [0, 13, 7], [1, 1, 1]),
    ground: transform([0, 0, 0], [0, 2, 0], [0.5, 0.5, 0.5]),
    fixed: transform([0, 180, 0], [0, 0, 0], [0.5, 0.5, 0.5]),
  }),
});

function transform(
  rotation: DisplayTransform['rotation'],
  translation: DisplayTransform['translation'],
  scale: DisplayTransform['scale'],
): DisplayTransform {
  return { rotation, translation, scale };
}

export function resolveDisplayTransforms(
  spec: Pick<ModelSpec, 'display' | 'displayPreset'>,
): Readonly<Partial<Record<DisplayContext, DisplayTransform>>> {
  const preset = DISPLAY_PRESETS[spec.displayPreset];
  const result: Partial<Record<DisplayContext, DisplayTransform>> = {};
  for (const context of DISPLAY_CONTEXTS) {
    const value = spec.display[context] ?? preset[context];
    if (value !== undefined) result[context] = value;
  }
  return result;
}

function roundUv(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function activeFaces(part: ModelPart): readonly ModelFace[] {
  if (part.uvMode === 'manual') {
    return FACE_ORDER.filter((face) => part.faces?.[face] !== undefined);
  }
  if (part.shape === 'cuboid') return FACE_ORDER;
  if (part.from[0] === part.to[0]) return ['west', 'east'];
  if (part.from[1] === part.to[1]) return ['down', 'up'];
  return ['north', 'south'];
}

function pixelBoundsForCell(
  index: number,
  count: number,
  width: number,
  height: number,
): readonly [number, number, number, number] {
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  const column = index % columns;
  const row = Math.floor(index / columns);
  return [
    Math.floor((column * width) / columns),
    Math.floor(((row + 1) * height) / rows),
    Math.floor(((column + 1) * width) / columns),
    Math.floor((row * height) / rows),
  ];
}

function modelUvFromPixels(
  pixels: readonly [number, number, number, number],
  width: number,
  height: number,
): readonly [number, number, number, number] {
  return [
    roundUv((pixels[0] * 16) / width),
    roundUv((pixels[1] * 16) / height),
    roundUv((pixels[2] * 16) / width),
    roundUv((pixels[3] * 16) / height),
  ];
}

function manualPixelBounds(
  face: FaceUv,
  width: number,
  height: number,
): readonly [number, number, number, number] {
  return [
    roundUv((face.uv[0] * width) / 16),
    roundUv((face.uv[1] * height) / 16),
    roundUv((face.uv[2] * width) / 16),
    roundUv((face.uv[3] * height) / 16),
  ];
}

function createUvLayout(spec: ModelSpec): readonly UvAssignment[] {
  const [width, height] = spec.textureSize;
  const assignments: UvAssignment[] = [];
  const sortedParts = [...spec.parts].sort((left, right) =>
    compareVisualStrings(left.id, right.id),
  );
  const automaticByMaterial = new Map<string, { part: ModelPart; face: ModelFace }[]>();

  for (const part of sortedParts) {
    for (const face of activeFaces(part)) {
      const manualFace = part.faces?.[face];
      if (part.uvMode === 'manual' && manualFace !== undefined) {
        assignments.push({
          partId: part.id,
          materialId: part.material,
          face,
          uv: manualFace.uv,
          pixelBounds: manualPixelBounds(manualFace, width, height),
          automatic: false,
        });
        continue;
      }
      const entries = automaticByMaterial.get(part.material) ?? [];
      entries.push({ part, face });
      automaticByMaterial.set(part.material, entries);
    }
  }

  for (const materialId of [...automaticByMaterial.keys()].sort(compareVisualStrings)) {
    const entries = automaticByMaterial.get(materialId) ?? [];
    for (const [index, entry] of entries.entries()) {
      const pixels = pixelBoundsForCell(index, entries.length, width, height);
      assignments.push({
        partId: entry.part.id,
        materialId,
        face: entry.face,
        uv: modelUvFromPixels(pixels, width, height),
        pixelBounds: pixels,
        automatic: true,
      });
    }
  }

  return assignments.sort((left, right) => {
    const part = compareVisualStrings(left.partId, right.partId);
    if (part !== 0) return part;
    return FACE_ORDER.indexOf(left.face) - FACE_ORDER.indexOf(right.face);
  });
}

function textureResourceId(spec: ModelSpec, materialId: string): string {
  const configured = spec.materials[materialId]?.texture;
  if (configured !== undefined) return configured;
  const { namespace, path } = parseResourceId(spec.id);
  return `${namespace}:item/${path}/${materialId}`;
}

function textureFilePath(resourceId: string): string {
  const { namespace, path } = parseResourceId(resourceId);
  return `assets/${namespace}/textures/${path}.png`;
}

function createTextureRequirements(spec: ModelSpec): readonly TextureRequirement[] {
  const materials = [...new Set(spec.parts.map((part) => part.material))].sort(
    compareVisualStrings,
  );
  return materials.map((materialId) => {
    const material = spec.materials[materialId];
    const resourceId = textureResourceId(spec, materialId);
    return {
      materialId,
      resourceId,
      path: textureFilePath(resourceId),
      width: spec.textureSize[0],
      height: spec.textureSize[1],
      ...(material?.tintIndex === undefined ? {} : { tintIndex: material.tintIndex }),
      ...(material?.color === undefined ? {} : { color: material.color }),
      emissive: material?.emissive ?? false,
      transparent: material?.transparent ?? false,
      external: material?.texture !== undefined,
    };
  });
}

function resolveGeometryFaces(
  spec: ModelSpec,
  part: ModelPart,
  uvByFace: ReadonlyMap<string, UvAssignment>,
): Readonly<Partial<Record<ModelFace, CompiledGeometryFace>>> {
  const material = spec.materials[part.material];
  const result: Partial<Record<ModelFace, CompiledGeometryFace>> = {};
  for (const face of activeFaces(part)) {
    const assignment = uvByFace.get(`${part.id}\u0000${face}`);
    if (assignment === undefined) continue;
    const manual = part.faces?.[face];
    result[face] = {
      uv: assignment.uv,
      ...(manual === undefined || manual.rotation === 0 ? {} : { rotation: manual.rotation }),
      ...(material?.tintIndex === undefined ? {} : { tintIndex: material.tintIndex }),
    };
  }
  return result;
}

function resolveGeometryElements(
  spec: ModelSpec,
  uvLayout: readonly UvAssignment[],
): readonly CompiledGeometryElement[] {
  const uvByFace = new Map(
    uvLayout.map((assignment) => [`${assignment.partId}\u0000${assignment.face}`, assignment]),
  );
  return [...spec.parts]
    .sort((left, right) => compareVisualStrings(left.id, right.id))
    .map((part) => ({
      partId: part.id,
      shape: part.shape,
      from: part.from,
      to: part.to,
      materialId: part.material,
      ...(part.rotation === undefined || part.rotation.angle === 0
        ? {}
        : {
            rotation: {
              axis: part.rotation.axis,
              angle: part.rotation.angle,
              pivot: part.rotation.pivot,
              rescale: part.rotation.rescale,
            },
          }),
      shade: part.shade,
      faces: resolveGeometryFaces(spec, part, uvByFace),
    }));
}

function compileElement(element: CompiledGeometryElement): Record<string, unknown> {
  return {
    from: [...element.from],
    to: [...element.to],
    ...(element.rotation === undefined
      ? {}
      : {
          rotation: {
            origin: [...element.rotation.pivot],
            axis: element.rotation.axis,
            angle: element.rotation.angle,
            rescale: element.rotation.rescale,
          },
        }),
    ...(element.shade ? {} : { shade: false }),
    faces: Object.fromEntries(
      FACE_ORDER.flatMap((face) => {
        const value = element.faces[face];
        return value === undefined
          ? []
          : [
              [
                face,
                {
                  uv: [...value.uv],
                  texture: `#${element.materialId}`,
                  ...(value.rotation === undefined ? {} : { rotation: value.rotation }),
                  ...(value.tintIndex === undefined ? {} : { tintindex: value.tintIndex }),
                },
              ] as const,
            ];
      }),
    ),
  };
}

function rgbValues(color: string | undefined): readonly [number, number, number] {
  if (color === undefined) return [1, 1, 1];
  const red = Number.parseInt(color.slice(1, 3), 16) / 255;
  const green = Number.parseInt(color.slice(3, 5), 16) / 255;
  const blue = Number.parseInt(color.slice(5, 7), 16) / 255;
  return [roundUv(red), roundUv(green), roundUv(blue)];
}

function createTintSources(spec: ModelSpec): readonly Record<string, unknown>[] {
  const indexed = new Map<number, readonly [number, number, number]>();
  for (const material of Object.values(spec.materials)) {
    if (material.tintIndex !== undefined) {
      indexed.set(material.tintIndex, rgbValues(material.color));
    }
  }
  if (indexed.size === 0) return [];
  const highest = Math.max(...indexed.keys());
  return Array.from({ length: highest + 1 }, (_unused, index) => ({
    type: 'minecraft:constant',
    value: [...(indexed.get(index) ?? [1, 1, 1])],
  }));
}

function modelReference(
  model: string,
  tints: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return {
    type: 'minecraft:model',
    model,
    ...(tints.length === 0 ? {} : { tints }),
  };
}

function compileState(
  state: ItemState,
  fallback: Record<string, unknown>,
  tints: readonly Record<string, unknown>[],
): Record<string, unknown> {
  switch (state.kind) {
    case 'condition': {
      const selected = modelReference(state.model, tints);
      return {
        ...state.parameters,
        type: 'minecraft:condition',
        property: state.property,
        on_true: state.when ? selected : fallback,
        on_false: state.when ? fallback : selected,
      };
    }
    case 'select':
      return {
        ...state.parameters,
        type: 'minecraft:select',
        property: state.property,
        cases: state.cases.map((entry) => ({
          when: entry.when,
          model: modelReference(entry.model, tints),
        })),
        fallback,
      };
    case 'range_dispatch':
      return {
        ...state.parameters,
        type: 'minecraft:range_dispatch',
        property: state.property,
        scale: state.scale,
        entries: [...state.entries]
          .sort((left, right) => left.threshold - right.threshold)
          .map((entry) => ({
            threshold: entry.threshold,
            model: modelReference(entry.model, tints),
          })),
        fallback,
      };
    case 'composite':
      return {
        type: 'minecraft:composite',
        models: [fallback, ...state.models.map((model) => modelReference(model, tints))],
      };
  }
}

function compileItemDefinition(spec: ModelSpec, modelResourceId: string): Record<string, unknown> {
  const tints = createTintSources(spec);
  let root = modelReference(modelResourceId, tints);
  for (let index = spec.states.length - 1; index >= 0; index -= 1) {
    const state = spec.states[index];
    if (state !== undefined) root = compileState(state, root, tints);
  }
  return { model: root };
}

function compileDisplay(spec: ModelSpec): Record<string, unknown> {
  const resolved = resolveDisplayTransforms(spec);
  const result: Record<string, unknown> = {};
  for (const context of DISPLAY_CONTEXTS) {
    const value = resolved[context];
    if (value === undefined) continue;
    result[context] = {
      rotation: [...value.rotation],
      translation: [...value.translation],
      scale: [...value.scale],
    };
  }
  return result;
}

function compileGeometryModel(
  spec: ModelSpec,
  textures: readonly TextureRequirement[],
  geometry: readonly CompiledGeometryElement[],
): Record<string, unknown> {
  const textureAliases = Object.fromEntries(
    textures.map((texture) => [texture.materialId, texture.resourceId]),
  );
  const firstTexture = textures[0];
  return {
    parent: parentModelResourceId(spec),
    gui_light: 'front',
    textures: {
      ...textureAliases,
      ...(firstTexture === undefined ? {} : { layer0: firstTexture.resourceId }),
    },
    elements: geometry.map(compileElement),
    display: compileDisplay(spec),
  };
}

function parentModelResourceId(
  spec: ModelSpec,
): 'minecraft:item/generated' | 'minecraft:item/handheld' {
  return spec.template === 'flat' ? 'minecraft:item/generated' : 'minecraft:item/handheld';
}

function collectExternalModels(spec: ModelSpec): readonly string[] {
  const references: string[] = [];
  for (const state of spec.states) {
    if (state.kind === 'condition') references.push(state.model);
    if (state.kind === 'select') references.push(...state.cases.map((entry) => entry.model));
    if (state.kind === 'range_dispatch') {
      references.push(...state.entries.map((entry) => entry.model));
    }
    if (state.kind === 'composite') references.push(...state.models);
  }
  return [...new Set(references)].sort(compareVisualStrings);
}

function compiledFile(
  path: string,
  resourceId: string,
  role: CompiledVisualFileRole,
  value: unknown,
): CompiledVisualFile {
  const content = serializeVisualJson(value);
  return {
    path,
    resourceId,
    role,
    content,
    mediaType: 'application/json',
    sha256: sha256Buffer(content),
  };
}

/** Compile a validated semantic item model into Minecraft 26.2 client assets. */
export function compileItemAsset(input: unknown): CompiledItemAsset {
  const spec = parseModelSpec(input);
  const { namespace, path } = parseResourceId(spec.id);
  const modelResourceId = `${namespace}:item/${path}`;
  const modelPath = `assets/${namespace}/models/item/${path}.json`;
  const itemDefinitionPath = `assets/${namespace}/items/${path}.json`;
  const textures = createTextureRequirements(spec);
  const uvLayout = createUvLayout(spec);
  const geometry = resolveGeometryElements(spec, uvLayout);
  const geometryModel = compileGeometryModel(spec, textures, geometry);
  const itemDefinition = compileItemDefinition(spec, modelResourceId);
  const files = [
    compiledFile(itemDefinitionPath, spec.id, 'item_definition', itemDefinition),
    compiledFile(modelPath, modelResourceId, 'model', geometryModel),
  ].sort((left, right) => compareVisualStrings(left.path, right.path));

  return {
    kind: 'item',
    minecraftVersion: VISUAL_MINECRAFT_VERSION,
    resourcePackFormat: RESOURCE_PACK_FORMAT_26_2,
    spec,
    itemDefinitionResourceId: spec.id,
    modelResourceId,
    parentModelResourceId: parentModelResourceId(spec),
    files,
    textures,
    uvLayout,
    geometry,
    externalModelReferences: collectExternalModels(spec),
  };
}

const itemModelBindingStrategy: BindingStrategy<ItemBindingProposal> = {
  id: 'minecraft:item_model',
  targetKind: 'item',
  propose(spec: ModelSpec, compiled: CompiledItemAsset, carrierItem?: string): ItemBindingProposal {
    const carrier = carrierItem ?? spec.connection?.carrierItem ?? 'minecraft:stick';
    parseResourceId(carrier);
    const requiredFiles = compiled.files.map((file) => file.path).sort(compareVisualStrings);
    return {
      schemaVersion: 1,
      id: `item-model:${spec.id}`,
      strategy: 'minecraft:item_model',
      capability: 'native',
      logicalItem: spec.id,
      carrierItem: carrier,
      component: {
        id: 'minecraft:item_model',
        value: compiled.itemDefinitionResourceId,
      },
      itemStack: {
        id: carrier,
        count: 1,
        components: {
          'minecraft:item_model': compiled.itemDefinitionResourceId,
        },
      },
      giveCommand: `give @s ${carrier}[minecraft:item_model="${compiled.itemDefinitionResourceId}"] 1`,
      itemDefinitionResourceId: compiled.itemDefinitionResourceId,
      requiredFiles,
    };
  },
};

export const ITEM_MODEL_BINDING_STRATEGY = Object.freeze(itemModelBindingStrategy);

export function createItemBindingProposal(
  input: unknown,
  compiled?: CompiledItemAsset,
  carrierItem?: string,
): ItemBindingProposal {
  const spec = parseModelSpec(input);
  const artifact = compiled ?? compileItemAsset(spec);
  if (artifact.spec.id !== spec.id) {
    throw new Error(
      `Compiled asset '${artifact.spec.id}' does not match binding input '${spec.id}'.`,
    );
  }
  return ITEM_MODEL_BINDING_STRATEGY.propose(spec, artifact, carrierItem);
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort(compareVisualStrings)
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, sortJsonValue(record[key])]),
    );
  }
  return value;
}

export function serializeVisualJson(value: unknown): string {
  return `${JSON.stringify(sortJsonValue(value), undefined, 2)}\n`;
}
