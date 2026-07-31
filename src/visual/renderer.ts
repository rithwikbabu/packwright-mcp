import { createHash } from 'node:crypto';

import {
  compileItemAsset,
  resolveDisplayTransforms,
  type CompiledGeometryElement,
  type ModelFace,
} from './compiler.js';
import { MAX_MODEL_PARTS, type ModelSpec } from './model-spec.js';
import { encodePng, type PixelImage } from './png.js';

export type Vec3 = readonly [number, number, number];
export type Rgba = readonly [number, number, number, number];

export interface RenderRotation {
  readonly axis: 'x' | 'y' | 'z';
  readonly angle: number;
  readonly pivot?: Vec3 | undefined;
  readonly rescale?: boolean | undefined;
}

export interface RenderFace {
  readonly texture?: string | undefined;
  /** Minecraft model UV coordinates in the fixed 0..16 texture space. */
  readonly uv?: readonly [number, number, number, number] | undefined;
  readonly tint?: Rgba | undefined;
  readonly emissive?: boolean | undefined;
  readonly rotation?: 0 | 90 | 180 | 270 | undefined;
}

export interface RenderCuboid {
  readonly id: string;
  readonly shape?: 'cuboid' | 'plane' | undefined;
  readonly from: Vec3;
  readonly to: Vec3;
  readonly material: string;
  readonly parent?: string | undefined;
  readonly rotation?: RenderRotation | undefined;
  readonly shade?: boolean | undefined;
  readonly faces?:
    | Readonly<Partial<Record<'down' | 'east' | 'north' | 'south' | 'up' | 'west', RenderFace>>>
    | undefined;
}

export interface RenderMaterial {
  readonly texture?: PixelImage | undefined;
  readonly color?: Rgba | undefined;
  readonly tint?: Rgba | undefined;
  readonly emissive?: boolean | undefined;
}

export interface RenderDisplayTransform {
  readonly rotation?: Vec3 | undefined;
  readonly translation?: Vec3 | undefined;
  readonly scale?: Vec3 | undefined;
}

export interface CuboidRenderScene {
  readonly id: string;
  readonly targetKind: 'block' | 'display' | 'item';
  readonly parts: readonly RenderCuboid[];
  readonly materials?: Readonly<Record<string, RenderMaterial>> | undefined;
  readonly displayTransforms?: Readonly<Record<string, RenderDisplayTransform>> | undefined;
}

export type StandardRenderViewId =
  | 'block_world'
  | 'fixed'
  | 'firstperson_lefthand'
  | 'firstperson_righthand'
  | 'ground'
  | 'inventory_32'
  | 'inventory_64'
  | 'thirdperson_hand'
  | 'turntable_front'
  | 'turntable_front_left'
  | 'turntable_front_right'
  | 'turntable_left'
  | 'turntable_rear'
  | 'turntable_rear_left'
  | 'turntable_rear_right'
  | 'turntable_right';

export interface RenderedView {
  readonly id: StandardRenderViewId;
  readonly width: number;
  readonly height: number;
  readonly image: PixelImage;
  readonly png: Buffer;
  readonly sha256: string;
}

export interface ContactSheetPlacement {
  readonly viewId: StandardRenderViewId;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface RenderedContactSheet {
  readonly width: number;
  readonly height: number;
  readonly image: PixelImage;
  readonly png: Buffer;
  readonly sha256: string;
  readonly placements: readonly ContactSheetPlacement[];
}

export interface RenderBundle {
  readonly sceneId: string;
  readonly renderer: 'packwright-cpu-v1';
  readonly views: readonly RenderedView[];
  readonly contactSheet: RenderedContactSheet;
}

export interface RenderOptions {
  /** Square size for turntable and hand/item-frame views. Defaults to 96; maximum 256. */
  readonly viewSize?: number | undefined;
  readonly background?: Rgba | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Include inventory, ground, fixed, hand, and applicable block-world context views. */
  readonly includeContexts?: boolean | undefined;
  readonly includeBlockWorld?: boolean | undefined;
}

export interface RenderModelSpecOptions extends RenderOptions {
  /** Texture pixels keyed by material ID or namespaced texture ID. */
  readonly textures?: Readonly<Record<string, PixelImage>> | undefined;
}

interface MutableVec3 {
  x: number;
  y: number;
  z: number;
}

interface TextureCoordinate {
  u: number;
  v: number;
}

interface RasterVertex extends MutableVec3, TextureCoordinate {}

interface RasterJob {
  readonly vertices: readonly [RasterVertex, RasterVertex, RasterVertex];
  readonly material: RenderMaterial | undefined;
  readonly fallback: Rgba;
  readonly face: RenderFace | undefined;
  readonly light: number;
  readonly averageDepth: number;
}

interface RenderBudget {
  remainingSamples: number;
}

interface FaceDefinition {
  readonly id: keyof NonNullable<RenderCuboid['faces']>;
  readonly points: readonly [Vec3, Vec3, Vec3, Vec3];
  readonly normal: Vec3;
}

interface ViewDefinition {
  readonly id: StandardRenderViewId;
  readonly yaw: number;
  readonly pitch: number;
  readonly roll: number;
  readonly scale: number;
  readonly width: number;
  readonly height: number;
  readonly perspective: number;
  readonly transformKey?: string | undefined;
}

const MAX_VIEW_SIZE = 256;
const CONTACT_COLUMNS = 4;
const CONTACT_CELL_SIZE = 100;
const CONTACT_INSET = 4;
const MAX_CONTACT_SHEET_BYTES = 720 * 1024;
const MAX_RASTER_SAMPLES = 50 * 1024 * 1024;
const MODEL_CENTER: Vec3 = [8, 8, 8];
const TRANSPARENT: Rgba = [0, 0, 0, 0];
const DEFAULT_BACKGROUND: Rgba = [28, 30, 36, 255];

export const CPU_RENDER_LIMITS = Object.freeze({
  maxParts: MAX_MODEL_PARTS,
  maxViewSize: MAX_VIEW_SIZE,
  maxContactSheetBytes: MAX_CONTACT_SHEET_BYTES,
  contactSheetCellSize: CONTACT_CELL_SIZE,
  maxRasterSamples: MAX_RASTER_SAMPLES,
});
const LIGHT_DIRECTION = normalizeVector({ x: -0.35, y: 0.78, z: 0.52 });
const VIEW_IDS = new Set<string>([
  'block_world',
  'fixed',
  'firstperson_lefthand',
  'firstperson_righthand',
  'ground',
  'inventory_32',
  'inventory_64',
  'thirdperson_hand',
  'turntable_front',
  'turntable_front_left',
  'turntable_front_right',
  'turntable_left',
  'turntable_rear',
  'turntable_rear_left',
  'turntable_rear_right',
  'turntable_right',
]);

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Visual rendering was cancelled.');
}

function finite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`);
}

function validateVec3(value: Vec3, label: string): void {
  value.forEach((coordinate, index) => finite(coordinate, `${label}[${String(index)}]`));
}

function validateColor(value: Rgba, label: string): void {
  value.forEach((channel, index) => {
    if (!Number.isInteger(channel) || channel < 0 || channel > 255) {
      throw new Error(`${label}[${String(index)}] must be an integer from 0 through 255.`);
    }
  });
}

function validateTexture(image: PixelImage, label: string): void {
  if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height)) {
    throw new Error(`${label} dimensions must be safe integers.`);
  }
  if (image.width <= 0 || image.height <= 0 || image.width > 4096 || image.height > 4096) {
    throw new Error(`${label} dimensions must be within 1 through 4096.`);
  }
  if (image.data.byteLength !== image.width * image.height * 4) {
    throw new Error(`${label} does not contain exactly one RGBA value per pixel.`);
  }
}

function validateScene(scene: CuboidRenderScene): Map<string, RenderCuboid> {
  if (scene.id.length === 0) throw new Error('Render scene ID must not be empty.');
  if (scene.parts.length === 0) throw new Error('Render scene must contain at least one part.');
  if (scene.parts.length > MAX_MODEL_PARTS) {
    throw new Error(`Render scene exceeds the ${String(MAX_MODEL_PARTS)}-part limit.`);
  }
  const byId = new Map<string, RenderCuboid>();
  for (const part of scene.parts) {
    if (part.id.length === 0 || byId.has(part.id)) {
      throw new Error(`Render part ID is empty or duplicated: ${part.id}`);
    }
    validateVec3(part.from, `Render part ${part.id}.from`);
    validateVec3(part.to, `Render part ${part.id}.to`);
    const flatAxes = part.to.filter(
      (coordinate, index) => coordinate === (part.from[index] ?? coordinate),
    ).length;
    if (part.to.some((coordinate, index) => coordinate < (part.from[index] ?? coordinate))) {
      throw new Error(`Render part ${part.id} has inverted bounds.`);
    }
    if (part.shape === 'plane' ? flatAxes !== 1 : flatAxes !== 0) {
      throw new Error(
        part.shape === 'plane'
          ? `Render plane ${part.id} must be flat on exactly one axis.`
          : `Render cuboid ${part.id} must have positive dimensions.`,
      );
    }
    if (part.rotation !== undefined) {
      finite(part.rotation.angle, `Render part ${part.id} rotation angle`);
      if (part.rotation.pivot !== undefined) {
        validateVec3(part.rotation.pivot, `Render part ${part.id} rotation pivot`);
      }
    }
    for (const [faceId, face] of Object.entries(part.faces ?? {})) {
      if (face.uv !== undefined) {
        face.uv.forEach((coordinate, index) =>
          finite(coordinate, `Render part ${part.id}.${faceId}.uv[${String(index)}]`),
        );
      }
      if (face.tint !== undefined)
        validateColor(face.tint, `Render part ${part.id}.${faceId}.tint`);
    }
    byId.set(part.id, part);
  }
  for (const part of scene.parts) {
    if (part.parent !== undefined && !byId.has(part.parent)) {
      throw new Error(`Render part ${part.id} references missing parent ${part.parent}.`);
    }
    const seen = new Set<string>();
    let cursor: RenderCuboid | undefined = part;
    while (cursor !== undefined) {
      if (seen.has(cursor.id))
        throw new Error(`Render part hierarchy contains a cycle at ${cursor.id}.`);
      seen.add(cursor.id);
      cursor = cursor.parent === undefined ? undefined : byId.get(cursor.parent);
    }
  }
  for (const [name, material] of Object.entries(scene.materials ?? {})) {
    if (material.texture !== undefined) validateTexture(material.texture, `Material ${name}`);
    if (material.color !== undefined) validateColor(material.color, `Material ${name}.color`);
    if (material.tint !== undefined) validateColor(material.tint, `Material ${name}.tint`);
  }
  return byId;
}

function radians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function deterministicSine(input: number): number {
  const fullTurn = Math.PI * 2;
  let value = ((((input + Math.PI) % fullTurn) + fullTurn) % fullTurn) - Math.PI;
  if (value > Math.PI / 2) value = Math.PI - value;
  if (value < -Math.PI / 2) value = -Math.PI - value;
  const square = value * value;
  return (
    value *
    (1 +
      square *
        (-1 / 6 +
          square *
            (1 / 120 + square * (-1 / 5040 + square * (1 / 362880 + square * (-1 / 39916800))))))
  );
}

function rotateAxis(point: MutableVec3, axis: RenderRotation['axis'], angle: number): MutableVec3 {
  const angleRadians = radians(angle);
  const sine = deterministicSine(angleRadians);
  const cosine = deterministicSine(angleRadians + Math.PI / 2);
  switch (axis) {
    case 'x':
      return {
        x: point.x,
        y: point.y * cosine - point.z * sine,
        z: point.y * sine + point.z * cosine,
      };
    case 'y':
      return {
        x: point.x * cosine + point.z * sine,
        y: point.y,
        z: -point.x * sine + point.z * cosine,
      };
    case 'z':
      return {
        x: point.x * cosine - point.y * sine,
        y: point.x * sine + point.y * cosine,
        z: point.z,
      };
  }
}

function rotateAround(point: MutableVec3, rotation: RenderRotation): MutableVec3 {
  const pivot = rotation.pivot ?? MODEL_CENTER;
  const local = { x: point.x - pivot[0], y: point.y - pivot[1], z: point.z - pivot[2] };
  if (rotation.rescale === true) {
    const cosine = Math.abs(deterministicSine(radians(rotation.angle) + Math.PI / 2));
    if (cosine < 1e-9) {
      throw new Error('Render element rescale is undefined for a quarter-turn rotation.');
    }
    const factor = 1 / cosine;
    if (rotation.axis !== 'x') local.x *= factor;
    if (rotation.axis !== 'y') local.y *= factor;
    if (rotation.axis !== 'z') local.z *= factor;
  }
  const rotated = rotateAxis(local, rotation.axis, rotation.angle);
  return { x: rotated.x + pivot[0], y: rotated.y + pivot[1], z: rotated.z + pivot[2] };
}

function applyHierarchy(
  input: Vec3,
  part: RenderCuboid,
  byId: ReadonlyMap<string, RenderCuboid>,
): MutableVec3 {
  let output: MutableVec3 = { x: input[0], y: input[1], z: input[2] };
  let cursor: RenderCuboid | undefined = part;
  while (cursor !== undefined) {
    if (cursor.rotation !== undefined) output = rotateAround(output, cursor.rotation);
    cursor = cursor.parent === undefined ? undefined : byId.get(cursor.parent);
  }
  return output;
}

function applyDisplayTransform(
  point: MutableVec3,
  transform?: RenderDisplayTransform,
): MutableVec3 {
  if (transform === undefined) return point;
  const scale = transform.scale ?? [1, 1, 1];
  let output: MutableVec3 = {
    x: (point.x - 8) * scale[0] + 8,
    y: (point.y - 8) * scale[1] + 8,
    z: (point.z - 8) * scale[2] + 8,
  };
  const [x, y, z] = transform.rotation ?? [0, 0, 0];
  output = rotateAround(output, { axis: 'x', angle: x });
  output = rotateAround(output, { axis: 'y', angle: y });
  output = rotateAround(output, { axis: 'z', angle: z });
  const translation = transform.translation ?? [0, 0, 0];
  return {
    x: output.x + translation[0],
    y: output.y + translation[1],
    z: output.z + translation[2],
  };
}

function applyView(point: MutableVec3, view: ViewDefinition): MutableVec3 {
  let output = { x: point.x - 8, y: point.y - 8, z: point.z - 8 };
  output = rotateAxis(output, 'y', view.yaw);
  output = rotateAxis(output, 'x', view.pitch);
  output = rotateAxis(output, 'z', view.roll);
  return output;
}

function project(point: MutableVec3, view: ViewDefinition): MutableVec3 {
  const perspective =
    view.perspective === 0 ? 1 : Math.max(0.25, view.perspective / (view.perspective - point.z));
  const pixelsPerUnit = (Math.min(view.width, view.height) / 20) * view.scale;
  return {
    x: view.width / 2 + point.x * pixelsPerUnit * perspective,
    y: view.height / 2 - point.y * pixelsPerUnit * perspective,
    z: point.z,
  };
}

function subtract(left: MutableVec3, right: MutableVec3): MutableVec3 {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function cross(left: MutableVec3, right: MutableVec3): MutableVec3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function normalizeVector(value: MutableVec3): MutableVec3 {
  const length = Math.hypot(value.x, value.y, value.z);
  return length === 0
    ? { x: 0, y: 0, z: 0 }
    : { x: value.x / length, y: value.y / length, z: value.z / length };
}

function lighting(
  points: readonly [MutableVec3, MutableVec3, MutableVec3, MutableVec3],
  emissive: boolean,
): number {
  if (emissive) return 1;
  const normal = normalizeVector(
    cross(subtract(points[1], points[0]), subtract(points[2], points[0])),
  );
  const diffuse = Math.max(
    0,
    normal.x * LIGHT_DIRECTION.x + normal.y * LIGHT_DIRECTION.y + normal.z * LIGHT_DIRECTION.z,
  );
  return 0.58 + diffuse * 0.42;
}

function colorFromName(name: string): Rgba {
  const digest = createHash('sha256').update(name).digest();
  return [
    80 + ((digest[0] ?? 0) % 144),
    80 + ((digest[1] ?? 0) % 144),
    80 + ((digest[2] ?? 0) % 144),
    255,
  ];
}

function multiplyColors(first: Rgba, second?: Rgba): Rgba {
  if (second === undefined) return first;
  return [
    Math.round((first[0] * second[0]) / 255),
    Math.round((first[1] * second[1]) / 255),
    Math.round((first[2] * second[2]) / 255),
    Math.round((first[3] * second[3]) / 255),
  ];
}

function sampleMaterial(
  material: RenderMaterial | undefined,
  fallback: Rgba,
  face: RenderFace | undefined,
  u: number,
  v: number,
): Rgba {
  let color = material?.color ?? fallback;
  const texture = material?.texture;
  if (texture !== undefined) {
    const x = Math.max(0, Math.min(texture.width - 1, Math.floor(u * texture.width)));
    const y = Math.max(0, Math.min(texture.height - 1, Math.floor(v * texture.height)));
    const offset = (y * texture.width + x) * 4;
    color = [
      texture.data[offset] ?? 0,
      texture.data[offset + 1] ?? 0,
      texture.data[offset + 2] ?? 0,
      texture.data[offset + 3] ?? 0,
    ];
  }
  return multiplyColors(multiplyColors(color, material?.tint), face?.tint);
}

function edge(a: RasterVertex, b: RasterVertex, x: number, y: number): number {
  return (x - a.x) * (b.y - a.y) - (y - a.y) * (b.x - a.x);
}

function rasterTriangle(
  output: Buffer,
  zBuffer: Float64Array,
  transparentZBuffer: Float64Array,
  width: number,
  height: number,
  vertices: readonly [RasterVertex, RasterVertex, RasterVertex],
  material: RenderMaterial | undefined,
  fallback: Rgba,
  face: RenderFace | undefined,
  light: number,
  pass: 'opaque' | 'transparent',
  budget: RenderBudget,
  signal?: AbortSignal,
): void {
  const [first, second, third] = vertices;
  const area = edge(first, second, third.x, third.y);
  if (Math.abs(area) < 1e-9) return;
  const minimumX = Math.max(0, Math.floor(Math.min(first.x, second.x, third.x)));
  const maximumX = Math.min(width - 1, Math.ceil(Math.max(first.x, second.x, third.x)));
  const minimumY = Math.max(0, Math.floor(Math.min(first.y, second.y, third.y)));
  const maximumY = Math.min(height - 1, Math.ceil(Math.max(first.y, second.y, third.y)));
  if (minimumX > maximumX || minimumY > maximumY) return;
  const samples = (maximumX - minimumX + 1) * (maximumY - minimumY + 1);
  budget.remainingSamples -= samples;
  if (budget.remainingSamples < 0) throw new Error('Visual render exceeded its raster-work limit.');
  for (let y = minimumY; y <= maximumY; y += 1) {
    abortIfNeeded(signal);
    for (let x = minimumX; x <= maximumX; x += 1) {
      const sampleX = x + 0.5;
      const sampleY = y + 0.5;
      const firstWeight = edge(second, third, sampleX, sampleY) / area;
      const secondWeight = edge(third, first, sampleX, sampleY) / area;
      const thirdWeight = 1 - firstWeight - secondWeight;
      if (firstWeight < -1e-9 || secondWeight < -1e-9 || thirdWeight < -1e-9) continue;
      const depth = first.z * firstWeight + second.z * secondWeight + third.z * thirdWeight;
      const pixel = y * width + x;
      if (depth <= (zBuffer[pixel] ?? Number.NEGATIVE_INFINITY)) continue;
      if (
        pass === 'transparent' &&
        depth <= (transparentZBuffer[pixel] ?? Number.NEGATIVE_INFINITY) + 1e-9
      ) {
        continue;
      }
      const u = first.u * firstWeight + second.u * secondWeight + third.u * thirdWeight;
      const v = first.v * firstWeight + second.v * secondWeight + third.v * thirdWeight;
      const sampled = sampleMaterial(material, fallback, face, u, v);
      if (
        sampled[3] === 0 ||
        (pass === 'opaque' && sampled[3] !== 255) ||
        (pass === 'transparent' && sampled[3] === 255)
      ) {
        continue;
      }
      const sourceAlpha = sampled[3] / 255;
      const offset = pixel * 4;
      const red = Math.round(sampled[0] * light);
      const green = Math.round(sampled[1] * light);
      const blue = Math.round(sampled[2] * light);
      const destinationAlpha = (output[offset + 3] ?? 0) / 255;
      const combinedAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
      const blend = (source: number, destination: number): number =>
        combinedAlpha === 0
          ? 0
          : Math.round(
              (source * sourceAlpha + destination * destinationAlpha * (1 - sourceAlpha)) /
                combinedAlpha,
            );
      output[offset] = blend(red, output[offset] ?? 0);
      output[offset + 1] = blend(green, output[offset + 1] ?? 0);
      output[offset + 2] = blend(blue, output[offset + 2] ?? 0);
      output[offset + 3] = Math.round(combinedAlpha * 255);
      if (pass === 'opaque') zBuffer[pixel] = depth;
      else transparentZBuffer[pixel] = depth;
    }
  }
}

function faceDefinitions(part: RenderCuboid): readonly FaceDefinition[] {
  const [x0, y0, z0] = part.from;
  const [x1, y1, z1] = part.to;
  if (part.shape === 'plane') {
    if (x0 === x1) {
      return [
        {
          id: part.faces?.east === undefined ? 'west' : 'east',
          points: [
            [x0, y0, z0],
            [x0, y0, z1],
            [x0, y1, z1],
            [x0, y1, z0],
          ],
          normal: [-1, 0, 0],
        },
      ];
    }
    if (y0 === y1) {
      return [
        {
          id: part.faces?.up === undefined ? 'down' : 'up',
          points: [
            [x0, y0, z0],
            [x1, y0, z0],
            [x1, y0, z1],
            [x0, y0, z1],
          ],
          normal: [0, -1, 0],
        },
      ];
    }
    return [
      {
        id: part.faces?.south === undefined ? 'north' : 'south',
        points: [
          [x1, y0, z0],
          [x0, y0, z0],
          [x0, y1, z0],
          [x1, y1, z0],
        ],
        normal: [0, 0, -1],
      },
    ];
  }
  return [
    {
      id: 'north',
      points: [
        [x1, y0, z0],
        [x0, y0, z0],
        [x0, y1, z0],
        [x1, y1, z0],
      ],
      normal: [0, 0, -1],
    },
    {
      id: 'south',
      points: [
        [x0, y0, z1],
        [x1, y0, z1],
        [x1, y1, z1],
        [x0, y1, z1],
      ],
      normal: [0, 0, 1],
    },
    {
      id: 'west',
      points: [
        [x0, y0, z0],
        [x0, y0, z1],
        [x0, y1, z1],
        [x0, y1, z0],
      ],
      normal: [-1, 0, 0],
    },
    {
      id: 'east',
      points: [
        [x1, y0, z1],
        [x1, y0, z0],
        [x1, y1, z0],
        [x1, y1, z1],
      ],
      normal: [1, 0, 0],
    },
    {
      id: 'up',
      points: [
        [x0, y1, z1],
        [x1, y1, z1],
        [x1, y1, z0],
        [x0, y1, z0],
      ],
      normal: [0, 1, 0],
    },
    {
      id: 'down',
      points: [
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y0, z1],
        [x0, y0, z1],
      ],
      normal: [0, -1, 0],
    },
  ];
}

function normalizedUv(
  face: RenderFace | undefined,
): readonly [TextureCoordinate, TextureCoordinate, TextureCoordinate, TextureCoordinate] {
  const uv = face?.uv ?? [0, 0, 16, 16];
  const left = uv[0] / 16;
  const top = uv[1] / 16;
  const right = uv[2] / 16;
  const bottom = uv[3] / 16;
  const coordinates: [TextureCoordinate, TextureCoordinate, TextureCoordinate, TextureCoordinate] =
    [
      { u: right, v: bottom },
      { u: left, v: bottom },
      { u: left, v: top },
      { u: right, v: top },
    ];
  const turns = (face?.rotation ?? 0) / 90;
  return coordinates.map((_, index) => coordinates[(index + turns) % 4] ?? coordinates[0]) as [
    TextureCoordinate,
    TextureCoordinate,
    TextureCoordinate,
    TextureCoordinate,
  ];
}

function fill(image: Buffer, color: Rgba): void {
  for (let offset = 0; offset < image.length; offset += 4) {
    image[offset] = color[0];
    image[offset + 1] = color[1];
    image[offset + 2] = color[2];
    image[offset + 3] = color[3];
  }
}

function renderView(
  scene: CuboidRenderScene,
  byId: ReadonlyMap<string, RenderCuboid>,
  view: ViewDefinition,
  background: Rgba,
  budget: RenderBudget,
  signal?: AbortSignal,
): RenderedView {
  const data = Buffer.alloc(view.width * view.height * 4);
  fill(data, background);
  const zBuffer = new Float64Array(view.width * view.height);
  zBuffer.fill(Number.NEGATIVE_INFINITY);
  const transparentZBuffer = new Float64Array(view.width * view.height);
  transparentZBuffer.fill(Number.NEGATIVE_INFINITY);
  const displayTransform = scene.displayTransforms?.[view.transformKey ?? view.id];
  const jobs: RasterJob[] = [];
  for (const part of [...scene.parts].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  )) {
    abortIfNeeded(signal);
    const defaultMaterial = scene.materials?.[part.material];
    const fallback = colorFromName(part.material);
    for (const definition of faceDefinitions(part)) {
      const face = part.faces?.[definition.id];
      const material =
        face?.texture === undefined ? defaultMaterial : scene.materials?.[face.texture];
      const transformed = definition.points.map((point) => {
        const hierarchy = applyHierarchy(point, part, byId);
        const displayed = applyDisplayTransform(hierarchy, displayTransform);
        return applyView(displayed, view);
      }) as unknown as [MutableVec3, MutableVec3, MutableVec3, MutableVec3];
      const illumination = lighting(
        transformed,
        Boolean(face?.emissive ?? material?.emissive) || part.shade === false,
      );
      const projected = transformed.map((point) => project(point, view)) as unknown as [
        MutableVec3,
        MutableVec3,
        MutableVec3,
        MutableVec3,
      ];
      const uv = normalizedUv(face);
      const vertices = projected.map((point, index) => ({
        ...point,
        ...(uv[index] ?? { u: 0, v: 0 }),
      })) as unknown as [RasterVertex, RasterVertex, RasterVertex, RasterVertex];
      for (const triangle of [
        [vertices[0], vertices[1], vertices[2]],
        [vertices[0], vertices[2], vertices[3]],
      ] as const) {
        jobs.push({
          vertices: triangle,
          material,
          fallback,
          face,
          light: illumination,
          averageDepth: (triangle[0].z + triangle[1].z + triangle[2].z) / 3,
        });
      }
    }
  }
  const draw = (job: RasterJob, pass: 'opaque' | 'transparent'): void =>
    rasterTriangle(
      data,
      zBuffer,
      transparentZBuffer,
      view.width,
      view.height,
      job.vertices,
      job.material,
      job.fallback,
      job.face,
      job.light,
      pass,
      budget,
      signal,
    );
  jobs.forEach((job) => draw(job, 'opaque'));
  [...jobs]
    .sort((left, right) => left.averageDepth - right.averageDepth)
    .forEach((job) => draw(job, 'transparent'));
  const image: PixelImage = { width: view.width, height: view.height, data };
  const png = encodePng(image);
  return { id: view.id, width: view.width, height: view.height, image, png, sha256: sha256(png) };
}

function standardViews(
  size: number,
  includeContexts: boolean,
  includeBlockWorld: boolean,
): readonly ViewDefinition[] {
  const turntable = (id: StandardRenderViewId, yaw: number): ViewDefinition => ({
    id,
    yaw,
    pitch: -18,
    roll: 0,
    scale: 0.96,
    width: size,
    height: size,
    perspective: 0,
  });
  const turntableViews: readonly ViewDefinition[] = [
    turntable('turntable_front', 0),
    turntable('turntable_front_right', 45),
    turntable('turntable_right', 90),
    turntable('turntable_rear_right', 135),
    turntable('turntable_rear', 180),
    turntable('turntable_rear_left', 225),
    turntable('turntable_left', 270),
    turntable('turntable_front_left', 315),
  ];
  if (!includeContexts) return turntableViews;
  return [
    ...turntableViews,
    {
      id: 'inventory_64',
      yaw: 30,
      pitch: -25,
      roll: 0,
      scale: 0.9,
      width: 64,
      height: 64,
      perspective: 0,
      transformKey: 'gui',
    },
    {
      id: 'inventory_32',
      yaw: 30,
      pitch: -25,
      roll: 0,
      scale: 0.9,
      width: 32,
      height: 32,
      perspective: 0,
      transformKey: 'gui',
    },
    {
      id: 'ground',
      yaw: 45,
      pitch: -70,
      roll: 0,
      scale: 0.8,
      width: size,
      height: size,
      perspective: 0,
      transformKey: 'ground',
    },
    {
      id: 'fixed',
      yaw: 0,
      pitch: 0,
      roll: 0,
      scale: 0.9,
      width: size,
      height: size,
      perspective: 0,
      transformKey: 'fixed',
    },
    {
      id: 'firstperson_righthand',
      yaw: -55,
      pitch: -15,
      roll: -12,
      scale: 1.08,
      width: size,
      height: size,
      perspective: 42,
      transformKey: 'firstperson_righthand',
    },
    {
      id: 'firstperson_lefthand',
      yaw: 55,
      pitch: -15,
      roll: 12,
      scale: 1.08,
      width: size,
      height: size,
      perspective: 42,
      transformKey: 'firstperson_lefthand',
    },
    {
      id: 'thirdperson_hand',
      yaw: 25,
      pitch: -12,
      roll: 0,
      scale: 0.9,
      width: size,
      height: size,
      perspective: 48,
      transformKey: 'thirdperson_righthand',
    },
    ...(includeBlockWorld
      ? ([
          {
            id: 'block_world',
            yaw: 45,
            pitch: -30,
            roll: 0,
            scale: 0.9,
            width: size,
            height: size,
            perspective: 48,
          },
        ] as const)
      : []),
  ];
}

function drawNearest(
  destination: Buffer,
  destinationWidth: number,
  source: PixelImage,
  x: number,
  y: number,
  targetWidth: number,
  targetHeight: number,
): void {
  for (let targetY = 0; targetY < targetHeight; targetY += 1) {
    const sourceY = Math.min(
      source.height - 1,
      Math.floor((targetY * source.height) / targetHeight),
    );
    for (let targetX = 0; targetX < targetWidth; targetX += 1) {
      const sourceX = Math.min(
        source.width - 1,
        Math.floor((targetX * source.width) / targetWidth),
      );
      const sourceOffset = (sourceY * source.width + sourceX) * 4;
      const destinationOffset = ((y + targetY) * destinationWidth + x + targetX) * 4;
      destination[destinationOffset] = source.data[sourceOffset] ?? 0;
      destination[destinationOffset + 1] = source.data[sourceOffset + 1] ?? 0;
      destination[destinationOffset + 2] = source.data[sourceOffset + 2] ?? 0;
      destination[destinationOffset + 3] = source.data[sourceOffset + 3] ?? 255;
    }
  }
}

/** Combines standardized views into a bounded, deterministic review sheet. */
export function createContactSheet(views: readonly RenderedView[]): RenderedContactSheet {
  if (views.length === 0 || views.length > 16) {
    throw new Error('Contact sheet requires between one and sixteen views.');
  }
  for (const view of views) {
    if (!VIEW_IDS.has(view.id)) throw new Error(`Unknown standard render view ${view.id}.`);
    validateTexture(view.image, `Render view ${view.id}`);
  }
  const rows = Math.ceil(views.length / CONTACT_COLUMNS);
  const width = CONTACT_COLUMNS * CONTACT_CELL_SIZE;
  const height = rows * CONTACT_CELL_SIZE;
  const data = Buffer.alloc(width * height * 4);
  fill(data, [18, 20, 25, 255]);
  const placements: ContactSheetPlacement[] = [];
  views.forEach((view, index) => {
    const column = index % CONTACT_COLUMNS;
    const row = Math.floor(index / CONTACT_COLUMNS);
    const cellX = column * CONTACT_CELL_SIZE;
    const cellY = row * CONTACT_CELL_SIZE;
    const maximum = CONTACT_CELL_SIZE - CONTACT_INSET * 2;
    const scale = Math.min(maximum / view.width, maximum / view.height);
    const targetWidth = Math.max(1, Math.floor(view.width * scale));
    const targetHeight = Math.max(1, Math.floor(view.height * scale));
    const x = cellX + Math.floor((CONTACT_CELL_SIZE - targetWidth) / 2);
    const y = cellY + Math.floor((CONTACT_CELL_SIZE - targetHeight) / 2);
    drawNearest(data, width, view.image, x, y, targetWidth, targetHeight);
    const marker = colorFromName(view.id);
    for (let markerX = cellX; markerX < cellX + CONTACT_CELL_SIZE; markerX += 1) {
      const offset = (cellY * width + markerX) * 4;
      data[offset] = marker[0];
      data[offset + 1] = marker[1];
      data[offset + 2] = marker[2];
      data[offset + 3] = 255;
    }
    placements.push({ viewId: view.id, x, y, width: targetWidth, height: targetHeight });
  });
  const image: PixelImage = { width, height, data };
  const png = encodePng(image, { maxFileBytes: MAX_CONTACT_SHEET_BYTES });
  return { width, height, image, png, sha256: sha256(png), placements };
}

/** Renders a cuboid visual draft through fixed CPU-only camera and lighting paths. */
export function renderCuboidDraft(
  scene: CuboidRenderScene,
  options: RenderOptions = {},
): RenderBundle {
  abortIfNeeded(options.signal);
  const byId = validateScene(scene);
  const viewSize = options.viewSize ?? 96;
  if (!Number.isSafeInteger(viewSize) || viewSize < 32 || viewSize > MAX_VIEW_SIZE) {
    throw new Error(
      `Render view size must be an integer from 32 through ${String(MAX_VIEW_SIZE)}.`,
    );
  }
  const background = options.background ?? DEFAULT_BACKGROUND;
  validateColor(background, 'Render background');
  const includeContexts = options.includeContexts ?? true;
  const includeBlockWorld = options.includeBlockWorld ?? scene.targetKind === 'block';
  const budget: RenderBudget = { remainingSamples: MAX_RASTER_SAMPLES };
  const views = standardViews(viewSize, includeContexts, includeBlockWorld).map((view) =>
    renderView(scene, byId, view, background, budget, options.signal),
  );
  abortIfNeeded(options.signal);
  return {
    sceneId: scene.id,
    renderer: 'packwright-cpu-v1',
    views,
    contactSheet: createContactSheet(views),
  };
}

function parseHexColor(value: string | undefined): Rgba | undefined {
  if (value === undefined) return undefined;
  if (!/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/u.test(value)) {
    throw new Error('Model material color must be #RRGGBB or #RRGGBBAA.');
  }
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16),
    value.length === 9 ? Number.parseInt(value.slice(7, 9), 16) : 255,
  ];
}

/** Renders a semantic item from the compiler's canonical geometry and resolved display data. */
export function renderModelSpec(
  spec: ModelSpec,
  options: RenderModelSpecOptions = {},
): RenderBundle {
  const compiled = compileItemAsset(spec);
  const normalizedSpec = compiled.spec;
  const materials: Record<string, RenderMaterial> = {};
  for (const [id, material] of Object.entries(normalizedSpec.materials)) {
    const texture =
      options.textures?.[id] ??
      (material.texture === undefined ? undefined : options.textures?.[material.texture]);
    const color = parseHexColor(material.color);
    materials[id] = {
      ...(texture === undefined ? {} : { texture }),
      ...(texture === undefined && color !== undefined ? { color } : {}),
      ...(texture !== undefined && material.tintIndex !== undefined && color !== undefined
        ? { tint: color }
        : {}),
      emissive: material.emissive,
    };
  }
  const faces = (element: CompiledGeometryElement): NonNullable<RenderCuboid['faces']> => {
    const result: Partial<Record<ModelFace, RenderFace>> = {};
    for (const [face, value] of Object.entries(element.faces)) {
      result[face as ModelFace] = {
        uv: value.uv,
        ...(value.rotation === undefined ? {} : { rotation: value.rotation }),
      };
    }
    return result;
  };
  const parts: RenderCuboid[] = compiled.geometry.map((element) => ({
    id: element.partId,
    shape: element.shape,
    from: element.from,
    to: element.to,
    material: element.materialId,
    ...(element.rotation === undefined
      ? {}
      : {
          rotation: {
            axis: element.rotation.axis,
            angle: element.rotation.angle,
            pivot: element.rotation.pivot,
            rescale: element.rotation.rescale,
          },
        }),
    faces: faces(element),
    shade: element.shade,
  }));
  const displayTransforms: Record<string, RenderDisplayTransform> = {};
  for (const [context, transform] of Object.entries(resolveDisplayTransforms(normalizedSpec))) {
    displayTransforms[context] = transform;
  }
  return renderCuboidDraft(
    {
      id: normalizedSpec.id,
      targetKind: 'item',
      parts,
      materials,
      displayTransforms,
    },
    options,
  );
}

/** Creates an RGBA texture suitable for deterministic fixtures and palette-only drafts. */
export function solidTexture(width: number, height: number, color: Rgba): PixelImage {
  validateColor(color, 'Solid texture color');
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 4096 ||
    height > 4096 ||
    width * height > 16 * 1024 * 1024
  ) {
    throw new Error('Solid texture dimensions exceed renderer limits.');
  }
  const data = Buffer.alloc(width * height * 4);
  fill(data, color);
  const image: PixelImage = { width, height, data };
  validateTexture(image, 'Solid texture');
  return image;
}

export { TRANSPARENT };
