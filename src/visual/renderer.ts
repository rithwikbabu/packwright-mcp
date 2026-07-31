import { createHash } from 'node:crypto';

import {
  compileItemAsset,
  resolveDisplayTransforms,
  type CompiledItemAsset,
  type CompiledGeometryElement,
  type ModelFace,
} from './compiler.js';
import { MAX_MODEL_PARTS, type DisplayContext, type ModelSpec } from './model-spec.js';
import { encodePng, type PixelImage } from './png.js';
import {
  MAX_REVIEW_SCENES,
  REVIEW_PROFILE_RENDERER_VERSION,
  resolveReviewProfile,
  type PlayerReferenceRig,
  type ReviewCamera,
  type ReviewHand,
  type ReviewItemPose,
  type ReviewMeasurementResult,
  type ReviewMeasurementRule,
  type ReviewSceneDefinition,
  type SceneProfileEvaluation,
  type SceneProfilePlan,
} from './review-profile.js';
import { ARMOR_STAND_HEAD_ANCHOR, ARMOR_SLOT_ANCHORS } from './review-profiles/character.js';

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
  /** Reference geometry is rendered in scene space and never receives an item display transform. */
  readonly referenceLayer?:
    | 'arm'
    | 'armor_stand'
    | 'body'
    | 'bounds'
    | 'ground'
    | 'gui'
    | 'head'
    | 'hitbox'
    | 'neighbor'
    | 'palm'
    | 'path'
    | 'surface'
    | 'torso'
    | undefined;
  readonly applyDisplayTransform?: boolean | undefined;
  /** Compiled Minecraft elements render only faces explicitly present in their JSON. */
  readonly renderOnlyDefinedFaces?: boolean | undefined;
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
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly image: PixelImage;
  readonly png: Buffer;
  readonly sha256: string;
  readonly analysis?: RenderViewAnalysis | undefined;
}

export interface ContactSheetPlacement {
  readonly viewId: string;
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
  readonly renderer: 'packwright-cpu-v1' | typeof REVIEW_PROFILE_RENDERER_VERSION;
  readonly views: readonly RenderedView[];
  readonly contactSheet: RenderedContactSheet;
  readonly reviewProfile?: SceneProfilePlan | undefined;
  readonly evaluation?: SceneProfileEvaluation | undefined;
}

export interface RenderOptions {
  /** Square size for turntable and hand/item-frame views. Defaults to 96; maximum 256. */
  readonly viewSize?: number | undefined;
  readonly background?: Rgba | undefined;
  readonly signal?: AbortSignal | undefined;
  /** CPU-v1 only. Profile-required scenes are never removed by this compatibility flag. */
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

interface Bounds3 {
  minimum: MutableVec3;
  maximum: MutableVec3;
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
  readonly coverageBit: number;
  readonly partId: string;
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
  readonly id: string;
  readonly yaw: number;
  readonly pitch: number;
  readonly roll: number;
  readonly scale: number;
  readonly width: number;
  readonly height: number;
  readonly perspective: number;
  readonly transformKey?: string | undefined;
  readonly reviewCamera?: ReviewCamera | undefined;
  readonly hand?: ReviewHand | undefined;
  readonly itemPose?: ReviewItemPose | undefined;
  readonly center?: Vec3 | undefined;
}

export interface RenderViewAnalysis {
  readonly assetPixels: number;
  readonly assetCoveragePercent: number;
  readonly armOverlapPercent: number;
  readonly torsoOverlapPercent: number;
  readonly frameRetentionPercent: number;
  readonly clippedPartIds: readonly string[];
  readonly assetBounds?: RenderAnalysisBounds | undefined;
  readonly assetPartBounds: Readonly<Record<string, RenderAnalysisBounds>>;
  readonly referenceBounds: Readonly<Record<string, RenderAnalysisBounds>>;
  readonly referenceOverlapPercent: Readonly<Record<string, number>>;
}

export interface RenderAnalysisBounds {
  readonly minimum: Vec3;
  readonly maximum: Vec3;
}

const MAX_VIEW_SIZE = 256;
const MAX_REFERENCE_PARTS = 32;
const CONTACT_COLUMNS = 4;
const CONTACT_CELL_SIZE = 100;
const CONTACT_INSET = 4;
const MAX_CONTACT_SHEET_BYTES = 720 * 1024;
const CLIENT_PREVIEW_MAX_DIMENSION = 352;
const MAX_CLIENT_PREVIEW_BYTES = 600 * 1024;
const MAX_RASTER_SAMPLES = 50 * 1024 * 1024;
const MODEL_CENTER: Vec3 = [8, 8, 8];
const TRANSPARENT: Rgba = [0, 0, 0, 0];
const DEFAULT_BACKGROUND: Rgba = [28, 30, 36, 255];
const REVIEW_VIEW_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const COVERAGE_ASSET = 1;
const COVERAGE_ARM = 2;
const COVERAGE_TORSO = 4;
const COVERAGE_PALM = 8;
const COVERAGE_REFERENCE = 0;

export const CPU_RENDER_LIMITS = Object.freeze({
  maxParts: MAX_MODEL_PARTS,
  maxViewSize: MAX_VIEW_SIZE,
  maxContactSheetBytes: MAX_CONTACT_SHEET_BYTES,
  contactSheetCellSize: CONTACT_CELL_SIZE,
  maxRasterSamples: MAX_RASTER_SAMPLES,
});
const LIGHT_DIRECTION = normalizeVector({ x: -0.35, y: 0.78, z: 0.52 });
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
  const assetParts = scene.parts.filter((part) => part.referenceLayer === undefined).length;
  const referenceParts = scene.parts.length - assetParts;
  if (assetParts > MAX_MODEL_PARTS || referenceParts > MAX_REFERENCE_PARTS) {
    throw new Error(
      `Render scene exceeds the ${String(MAX_MODEL_PARTS)} asset-part or ${String(MAX_REFERENCE_PARTS)} reference-part limit.`,
    );
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
  hand?: ReviewHand,
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
  output = rotateAround(output, { axis: 'y', angle: hand === 'left' ? -y : y });
  output = rotateAround(output, { axis: 'z', angle: hand === 'left' ? -z : z });
  const translation = transform.translation ?? [0, 0, 0];
  return {
    x: output.x + (hand === 'left' ? -translation[0] : translation[0]),
    y: output.y + translation[1],
    z: output.z + translation[2],
  };
}

function applyItemPose(point: MutableVec3, pose?: ReviewItemPose): MutableVec3 {
  return pose === undefined ? point : applyDisplayTransform(point, pose);
}

function applyView(point: MutableVec3, view: ViewDefinition): MutableVec3 {
  const center = view.center ?? MODEL_CENTER;
  let output = { x: point.x - center[0], y: point.y - center[1], z: point.z - center[2] };
  output = rotateAxis(output, 'y', view.yaw);
  output = rotateAxis(output, 'x', view.pitch);
  output = rotateAxis(output, 'z', view.roll);
  return output;
}

function applyViewDirection(point: MutableVec3, view: ViewDefinition): MutableVec3 {
  let output = rotateAxis(point, 'y', view.yaw);
  output = rotateAxis(output, 'x', view.pitch);
  return rotateAxis(output, 'z', view.roll);
}

function project(point: MutableVec3, view: ViewDefinition): MutableVec3 {
  if (view.reviewCamera?.kind === 'perspective') {
    const depth = Math.max(view.reviewCamera.nearPlane, view.reviewCamera.cameraDistance - point.z);
    const halfAngle = radians(view.reviewCamera.verticalFovDegrees) / 2;
    const tangent = deterministicSine(halfAngle) / deterministicSine(halfAngle + Math.PI / 2);
    const focalLength = view.height / (2 * tangent);
    return {
      x: view.width / 2 + (point.x * focalLength) / depth,
      y: view.height / 2 - (point.y * focalLength) / depth,
      z: point.z,
    };
  }
  if (view.reviewCamera?.kind === 'orthographic') {
    const pixelsPerUnit = (Math.min(view.width, view.height) / 20) * view.reviewCamera.scale;
    return {
      x: view.width / 2 + point.x * pixelsPerUnit,
      y: view.height / 2 - point.y * pixelsPerUnit,
      z: point.z,
    };
  }
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
  coverage: Uint8Array,
  assetAlpha: Float64Array,
  coverageBit: number,
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
      if (depth <= (zBuffer[pixel] ?? Number.NEGATIVE_INFINITY)) continue;
      if (
        pass === 'transparent' &&
        depth <= (transparentZBuffer[pixel] ?? Number.NEGATIVE_INFINITY) + 1e-9
      ) {
        continue;
      }
      const sourceAlpha = sampled[3] / 255;
      if (pass === 'opaque') {
        coverage[pixel] = coverageBit;
        assetAlpha[pixel] = coverageBit === COVERAGE_ASSET ? sourceAlpha : 0;
      } else {
        coverage[pixel] = (coverage[pixel] ?? 0) | coverageBit;
        if (coverageBit === COVERAGE_ASSET) {
          assetAlpha[pixel] = sourceAlpha + (assetAlpha[pixel] ?? 0) * (1 - sourceAlpha);
        }
      }
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

function includeBounds(bounds: Bounds3 | undefined, point: MutableVec3): Bounds3 {
  if (bounds === undefined) {
    return {
      minimum: { ...point },
      maximum: { ...point },
    };
  }
  bounds.minimum.x = Math.min(bounds.minimum.x, point.x);
  bounds.minimum.y = Math.min(bounds.minimum.y, point.y);
  bounds.minimum.z = Math.min(bounds.minimum.z, point.z);
  bounds.maximum.x = Math.max(bounds.maximum.x, point.x);
  bounds.maximum.y = Math.max(bounds.maximum.y, point.y);
  bounds.maximum.z = Math.max(bounds.maximum.z, point.z);
  return bounds;
}

function boundsVolume(bounds: Bounds3): number {
  return (
    Math.max(0, bounds.maximum.x - bounds.minimum.x) *
    Math.max(0, bounds.maximum.y - bounds.minimum.y) *
    Math.max(0, bounds.maximum.z - bounds.minimum.z)
  );
}

function intersectionVolume(left: Bounds3, right: Bounds3): number {
  return (
    Math.max(
      0,
      Math.min(left.maximum.x, right.maximum.x) - Math.max(left.minimum.x, right.minimum.x),
    ) *
    Math.max(
      0,
      Math.min(left.maximum.y, right.maximum.y) - Math.max(left.minimum.y, right.minimum.y),
    ) *
    Math.max(
      0,
      Math.min(left.maximum.z, right.maximum.z) - Math.max(left.minimum.z, right.minimum.z),
    )
  );
}

function mergeBounds(values: readonly Bounds3[]): Bounds3 | undefined {
  let merged: Bounds3 | undefined;
  for (const value of values) {
    merged = includeBounds(merged, value.minimum);
    merged = includeBounds(merged, value.maximum);
  }
  return merged;
}

function analysisBounds(bounds: Bounds3): RenderAnalysisBounds {
  return {
    minimum: [bounds.minimum.x, bounds.minimum.y, bounds.minimum.z],
    maximum: [bounds.maximum.x, bounds.maximum.y, bounds.maximum.z],
  };
}

function clipPolygonToNearPlane(
  vertices: readonly RasterVertex[],
  view: ViewDefinition,
): readonly RasterVertex[] {
  if (view.reviewCamera?.kind !== 'perspective') return vertices;
  const maximumZ = view.reviewCamera.cameraDistance - view.reviewCamera.nearPlane;
  const output: RasterVertex[] = [];
  for (let index = 0; index < vertices.length; index += 1) {
    const current = vertices[index];
    const previous = vertices[(index + vertices.length - 1) % vertices.length];
    if (current === undefined || previous === undefined) continue;
    const currentInside = current.z <= maximumZ;
    const previousInside = previous.z <= maximumZ;
    if (currentInside !== previousInside) {
      const denominator = current.z - previous.z;
      const amount = denominator === 0 ? 0 : (maximumZ - previous.z) / denominator;
      output.push({
        x: previous.x + (current.x - previous.x) * amount,
        y: previous.y + (current.y - previous.y) * amount,
        z: maximumZ,
        u: previous.u + (current.u - previous.u) * amount,
        v: previous.v + (current.v - previous.v) * amount,
      });
    }
    if (currentInside) output.push(current);
  }
  return output;
}

function polygonArea(vertices: readonly MutableVec3[]): number {
  let twiceArea = 0;
  for (let index = 0; index < vertices.length; index += 1) {
    const current = vertices[index];
    const next = vertices[(index + 1) % vertices.length];
    if (current === undefined || next === undefined) continue;
    twiceArea += current.x * next.y - next.x * current.y;
  }
  return Math.abs(twiceArea) / 2;
}

function clipPolygonAtBoundary(
  vertices: readonly RasterVertex[],
  inside: (point: RasterVertex) => boolean,
  intersect: (from: RasterVertex, to: RasterVertex) => RasterVertex,
): readonly RasterVertex[] {
  const output: RasterVertex[] = [];
  for (let index = 0; index < vertices.length; index += 1) {
    const current = vertices[index];
    const previous = vertices[(index + vertices.length - 1) % vertices.length];
    if (current === undefined || previous === undefined) continue;
    const currentInside = inside(current);
    const previousInside = inside(previous);
    if (currentInside !== previousInside) output.push(intersect(previous, current));
    if (currentInside) output.push(current);
  }
  return output;
}

function clipPolygonToViewport(
  vertices: readonly RasterVertex[],
  width: number,
  height: number,
): readonly RasterVertex[] {
  const vertical =
    (boundary: number) =>
    (from: RasterVertex, to: RasterVertex): RasterVertex => {
      const amount = to.x === from.x ? 0 : (boundary - from.x) / (to.x - from.x);
      return {
        x: boundary,
        y: from.y + (to.y - from.y) * amount,
        z: from.z + (to.z - from.z) * amount,
        u: from.u + (to.u - from.u) * amount,
        v: from.v + (to.v - from.v) * amount,
      };
    };
  const horizontal =
    (boundary: number) =>
    (from: RasterVertex, to: RasterVertex): RasterVertex => {
      const amount = to.y === from.y ? 0 : (boundary - from.y) / (to.y - from.y);
      return {
        x: from.x + (to.x - from.x) * amount,
        y: boundary,
        z: from.z + (to.z - from.z) * amount,
        u: from.u + (to.u - from.u) * amount,
        v: from.v + (to.v - from.v) * amount,
      };
    };
  let clipped = vertices;
  clipped = clipPolygonAtBoundary(clipped, (point) => point.x >= 0, vertical(0));
  clipped = clipPolygonAtBoundary(clipped, (point) => point.x <= width, vertical(width));
  clipped = clipPolygonAtBoundary(clipped, (point) => point.y >= 0, horizontal(0));
  return clipPolygonAtBoundary(clipped, (point) => point.y <= height, horizontal(height));
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
  const coverage = new Uint8Array(view.width * view.height);
  const assetAlpha = new Float64Array(view.width * view.height);
  const displayTransform = scene.displayTransforms?.[view.transformKey ?? view.id];
  const jobs: RasterJob[] = [];
  const clippedPartIds = new Set<string>();
  const worldBounds = new Map<
    string,
    { bounds: Bounds3; referenceLayer: RenderCuboid['referenceLayer'] }
  >();
  let assetProjectedArea = 0;
  let retainedAssetProjectedArea = 0;
  for (const part of [...scene.parts].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  )) {
    abortIfNeeded(signal);
    const defaultMaterial = scene.materials?.[part.material];
    const fallback = colorFromName(part.material);
    for (const definition of faceDefinitions(part)) {
      const face = part.faces?.[definition.id];
      if (part.renderOnlyDefinedFaces === true && face === undefined) continue;
      const material =
        face?.texture === undefined ? defaultMaterial : scene.materials?.[face.texture];
      const transformed = definition.points.map((point) => {
        const hierarchy = applyHierarchy(point, part, byId);
        const displayed =
          part.applyDisplayTransform === false
            ? hierarchy
            : applyItemPose(
                applyDisplayTransform(hierarchy, displayTransform, view.hand),
                view.itemPose,
              );
        const existing = worldBounds.get(part.id);
        worldBounds.set(part.id, {
          bounds: includeBounds(existing?.bounds, displayed),
          referenceLayer: part.referenceLayer,
        });
        return applyView(displayed, view);
      }) as unknown as [MutableVec3, MutableVec3, MutableVec3, MutableVec3];
      const illumination = lighting(
        transformed,
        Boolean(face?.emissive ?? material?.emissive) || part.shade === false,
      );
      const uv = normalizedUv(face);
      const vertices = transformed.map((point, index) => ({
        ...point,
        ...(uv[index] ?? { u: 0, v: 0 }),
      })) as unknown as [RasterVertex, RasterVertex, RasterVertex, RasterVertex];
      if (part.referenceLayer === undefined) {
        const nearClipped = clipPolygonToNearPlane(vertices, view);
        if (nearClipped.length < 3) {
          assetProjectedArea += view.width * view.height;
          clippedPartIds.add(part.id);
        } else {
          const projectedFace = nearClipped.map((point) => ({
            ...project(point, view),
            u: point.u,
            v: point.v,
          }));
          const totalArea = polygonArea(projectedFace);
          const retainedArea = polygonArea(
            clipPolygonToViewport(projectedFace, view.width, view.height),
          );
          assetProjectedArea += totalArea;
          retainedAssetProjectedArea += Math.min(totalArea, retainedArea);
          if (retainedArea + 1e-6 < totalArea) clippedPartIds.add(part.id);
        }
      }
      for (const sourceTriangle of [
        [vertices[0], vertices[1], vertices[2]],
        [vertices[0], vertices[2], vertices[3]],
      ] as const) {
        const clipped = clipPolygonToNearPlane(sourceTriangle, view);
        if (clipped.length < 3) continue;
        const raster = clipped.map((point) => ({
          ...project(point, view),
          u: point.u,
          v: point.v,
        }));
        for (let index = 1; index < raster.length - 1; index += 1) {
          const triangle = [raster[0], raster[index], raster[index + 1]] as const;
          const first = triangle[0];
          const second = triangle[1];
          const third = triangle[2];
          if (first === undefined || second === undefined || third === undefined) continue;
          jobs.push({
            vertices: [first, second, third],
            material,
            fallback,
            face,
            light: illumination,
            averageDepth: (first.z + second.z + third.z) / 3,
            coverageBit:
              part.referenceLayer === 'arm'
                ? COVERAGE_ARM
                : part.referenceLayer === 'torso'
                  ? COVERAGE_TORSO
                  : part.referenceLayer === 'palm'
                    ? COVERAGE_PALM
                    : part.referenceLayer === undefined
                      ? COVERAGE_ASSET
                      : COVERAGE_REFERENCE,
            partId: part.id,
          });
        }
      }
    }
  }
  const draw = (job: RasterJob, pass: 'opaque' | 'transparent'): void =>
    rasterTriangle(
      data,
      zBuffer,
      transparentZBuffer,
      coverage,
      assetAlpha,
      job.coverageBit,
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
  const alphaWeightedAssetPixels = assetAlpha.reduce((total, alpha) => total + alpha, 0);
  const assetPixels = Math.round(alphaWeightedAssetPixels);
  const assetPartEntries = [...worldBounds.entries()].filter(
    ([, entry]) => entry.referenceLayer === undefined,
  );
  const assetBounds = assetPartEntries.map(([, entry]) => entry);
  const assetVolume = assetBounds.reduce((total, entry) => total + boundsVolume(entry.bounds), 0);
  const collisionPercent = (layer: NonNullable<RenderCuboid['referenceLayer']>): number => {
    if (assetVolume === 0) return 0;
    const references = [...worldBounds.values()].filter((entry) => entry.referenceLayer === layer);
    const overlap = assetBounds.reduce(
      (assetTotal, asset) =>
        assetTotal +
        references.reduce(
          (referenceTotal, reference) =>
            referenceTotal + intersectionVolume(asset.bounds, reference.bounds),
          0,
        ),
      0,
    );
    return Math.min(100, (overlap * 100) / assetVolume);
  };
  const referenceLayers = [
    ...new Set(
      [...worldBounds.values()]
        .map((entry) => entry.referenceLayer)
        .filter(
          (layer): layer is NonNullable<RenderCuboid['referenceLayer']> => layer !== undefined,
        ),
    ),
  ].sort();
  const combinedAssetBounds = mergeBounds(assetBounds.map((entry) => entry.bounds));
  const combinedReferenceBounds: Record<string, RenderAnalysisBounds> = {};
  const referenceOverlapPercent: Record<string, number> = {};
  const assetPartBounds = Object.fromEntries(
    assetPartEntries.map(([id, entry]) => [id, analysisBounds(entry.bounds)] as const),
  );
  const rounded = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;
  for (const layer of referenceLayers) {
    const layerBounds = mergeBounds(
      [...worldBounds.values()]
        .filter((entry) => entry.referenceLayer === layer)
        .map((entry) => entry.bounds),
    );
    if (layerBounds !== undefined) combinedReferenceBounds[layer] = analysisBounds(layerBounds);
    referenceOverlapPercent[layer] = rounded(collisionPercent(layer));
  }
  const analysis: RenderViewAnalysis = {
    assetPixels,
    assetCoveragePercent: rounded((alphaWeightedAssetPixels * 100) / (view.width * view.height)),
    armOverlapPercent: rounded(collisionPercent('arm')),
    torsoOverlapPercent: rounded(collisionPercent('torso')),
    frameRetentionPercent: rounded(
      assetProjectedArea === 0 ? 100 : (retainedAssetProjectedArea * 100) / assetProjectedArea,
    ),
    clippedPartIds: [...clippedPartIds].sort(),
    assetPartBounds,
    ...(combinedAssetBounds === undefined
      ? {}
      : { assetBounds: analysisBounds(combinedAssetBounds) }),
    referenceBounds: combinedReferenceBounds,
    referenceOverlapPercent,
  };
  return {
    id: view.id,
    width: view.width,
    height: view.height,
    image,
    png,
    sha256: sha256(png),
    analysis,
  };
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

function reviewView(scene: ReviewSceneDefinition): ViewDefinition {
  const armorState = scene.assetState?.kind === 'armor' ? scene.assetState : undefined;
  const isolatedSlot =
    armorState?.visibleSlots.length === 1 ? armorState.visibleSlots[0] : undefined;
  return {
    id: scene.id,
    yaw: scene.camera.yaw,
    pitch: scene.camera.pitch,
    roll: scene.camera.roll,
    scale: scene.camera.kind === 'orthographic' ? scene.camera.scale : 1,
    width: scene.width,
    height: scene.height,
    perspective: 0,
    ...(scene.displayContext === undefined ? {} : { transformKey: scene.displayContext }),
    reviewCamera: scene.camera,
    ...(scene.hand === undefined ? {} : { hand: scene.hand }),
    ...(scene.itemPose === undefined ? {} : { itemPose: scene.itemPose }),
    ...(isolatedSlot === undefined ? {} : { center: ARMOR_SLOT_ANCHORS[isolatedSlot] }),
  };
}

const HELD_PROFILE_CALIBRATION = resolveDisplayTransforms({
  displayPreset: 'handheld_3d',
  display: {},
});
const HELD_PROFILE_PRIMARY_GRIP: Vec3 = [8, 5.5, 11];
const HELD_PROFILE_SECONDARY_GRIP: Vec3 = [8, 10.5, 11];

function palmDisplayContext(scene: ReviewSceneDefinition, hand: ReviewHand): DisplayContext {
  return scene.category === 'third_person'
    ? hand === 'right'
      ? 'thirdperson_righthand'
      : 'thirdperson_lefthand'
    : hand === 'right'
      ? 'firstperson_righthand'
      : 'firstperson_lefthand';
}

function calibratedPalm(
  scene: ReviewSceneDefinition,
  hand: ReviewHand,
  secondary = false,
): MutableVec3 {
  const context = palmDisplayContext(scene, hand);
  const transform = HELD_PROFILE_CALIBRATION[context];
  const point = secondary ? HELD_PROFILE_SECONDARY_GRIP : HELD_PROFILE_PRIMARY_GRIP;
  return applyItemPose(
    applyDisplayTransform({ x: point[0], y: point[1], z: point[2] }, transform, hand),
    scene.itemPose,
  );
}

function calibratedSecondaryPalm(scene: ReviewSceneDefinition, point: Vec3): MutableVec3 {
  const hand = scene.hand ?? 'right';
  const context =
    scene.displayContext ?? (hand === 'right' ? 'firstperson_righthand' : 'firstperson_lefthand');
  return applyItemPose(
    applyDisplayTransform(
      { x: point[0], y: point[1], z: point[2] },
      HELD_PROFILE_CALIBRATION[context],
      hand,
    ),
    scene.itemPose,
  );
}

function referenceCuboid(
  id: string,
  from: MutableVec3,
  to: MutableVec3,
  material: string,
  referenceLayer: NonNullable<RenderCuboid['referenceLayer']>,
): RenderCuboid {
  return {
    id,
    from: [from.x, from.y, from.z],
    to: [to.x, to.y, to.z],
    material,
    shade: true,
    referenceLayer,
    applyDisplayTransform: false,
  };
}

function addReferenceHand(
  parts: RenderCuboid[],
  scene: ReviewSceneDefinition,
  rig: PlayerReferenceRig,
  hand: ReviewHand,
  index: number,
  secondaryGrip?: Vec3,
): MutableVec3 {
  const palm =
    index > 0 && secondaryGrip !== undefined
      ? calibratedSecondaryPalm(scene, secondaryGrip)
      : calibratedPalm(scene, hand, index > 0);
  const halfWidth = rig.variant === 'steve' ? 2 : 1.5;
  const prefix = `~packwright_ref_${hand}_${String(index)}`;
  parts.push(
    referenceCuboid(
      `${prefix}_palm`,
      { x: palm.x - halfWidth, y: palm.y - 2, z: palm.z - 2 },
      { x: palm.x + halfWidth, y: palm.y + 2, z: palm.z + 2 },
      '~packwright_skin',
      'palm',
    ),
  );
  const poseOffset =
    rig.pose === 'swing_midpoint'
      ? hand === 'right'
        ? -2
        : 2
      : rig.pose === 'active_use' || rig.pose === 'aiming'
        ? hand === 'right'
          ? -1
          : 1
        : 0;
  parts.push(
    referenceCuboid(
      `${prefix}_arm`,
      { x: palm.x - halfWidth + poseOffset, y: palm.y - 11, z: palm.z - 2 },
      { x: palm.x + halfWidth + poseOffset, y: palm.y - 2, z: palm.z + 2 },
      '~packwright_sleeve',
      'arm',
    ),
  );
  return palm;
}

function referenceBox(
  parts: RenderCuboid[],
  id: string,
  from: Vec3,
  to: Vec3,
  material: string,
  layer: NonNullable<RenderCuboid['referenceLayer']>,
  rotation?: RenderRotation,
): void {
  parts.push({
    ...referenceCuboid(
      id,
      { x: from[0], y: from[1], z: from[2] },
      { x: to[0], y: to[1], z: to[2] },
      material,
      layer,
    ),
    ...(rotation === undefined ? {} : { rotation }),
  });
}

function referenceWireframe(
  parts: RenderCuboid[],
  prefix: string,
  from: Vec3,
  to: Vec3,
  material: string,
  layer: NonNullable<RenderCuboid['referenceLayer']>,
): void {
  const thickness = 0.18;
  for (const y of [from[1], to[1] - thickness]) {
    for (const z of [from[2], to[2] - thickness]) {
      referenceBox(
        parts,
        `${prefix}_x_${String(y)}_${String(z)}`,
        [from[0], y, z],
        [to[0], y + thickness, z + thickness],
        material,
        layer,
      );
    }
  }
  for (const x of [from[0], to[0] - thickness]) {
    for (const z of [from[2], to[2] - thickness]) {
      referenceBox(
        parts,
        `${prefix}_y_${String(x)}_${String(z)}`,
        [x, from[1], z],
        [x + thickness, to[1], z + thickness],
        material,
        layer,
      );
    }
  }
  for (const x of [from[0], to[0] - thickness]) {
    for (const y of [from[1], to[1] - thickness]) {
      referenceBox(
        parts,
        `${prefix}_z_${String(x)}_${String(y)}`,
        [x, y, from[2]],
        [x + thickness, y + thickness, to[2]],
        material,
        layer,
      );
    }
  }
}

const GUI_COUNT_DIGIT_SEGMENTS = Object.freeze([
  [0, 1, 2, 3, 4, 5],
  [1, 2],
  [0, 1, 3, 4, 6],
  [0, 1, 2, 3, 6],
  [1, 2, 5, 6],
  [0, 2, 3, 5, 6],
  [0, 2, 3, 4, 5, 6],
  [0, 1, 2],
  [0, 1, 2, 3, 4, 5, 6],
  [0, 1, 2, 3, 5, 6],
] as const);

/** Draws an original seven-segment approximation of Minecraft's stack-count glyph. */
function referenceGuiCount(
  parts: RenderCuboid[],
  prefix: string,
  count: number,
  material: string,
): void {
  const digits = String(count).split('').map(Number);
  const digitWidth = 2.3;
  const gap = 0.35;
  const totalWidth = digits.length * digitWidth + Math.max(0, digits.length - 1) * gap;
  const startX = 15.5 - totalWidth;
  const baseY = 0.8;
  const thickness = 0.32;
  const horizontal = (x: number, y: number): readonly [Vec3, Vec3] => [
    [x + thickness, y, 15.35],
    [x + digitWidth - thickness, y + thickness, 15.7],
  ];
  const vertical = (x: number, y: number): readonly [Vec3, Vec3] => [
    [x, y + thickness, 15.35],
    [x + thickness, y + 2.25 - thickness, 15.7],
  ];
  for (const [digitIndex, digit] of digits.entries()) {
    const x = startX + digitIndex * (digitWidth + gap);
    const segmentBounds = [
      horizontal(x, baseY + 4.5),
      vertical(x + digitWidth - thickness, baseY + 2.25),
      vertical(x + digitWidth - thickness, baseY),
      horizontal(x, baseY),
      vertical(x, baseY),
      vertical(x, baseY + 2.25),
      horizontal(x, baseY + 2.25),
    ] as const;
    for (const segment of GUI_COUNT_DIGIT_SEGMENTS[digit] ?? []) {
      const bounds = segmentBounds[segment];
      referenceBox(
        parts,
        `${prefix}_digit_${String(digitIndex)}_${String(segment)}`,
        bounds[0],
        bounds[1],
        material,
        'gui',
      );
    }
  }
}

function addProfileReferenceGeometry(
  parts: RenderCuboid[],
  materials: Record<string, RenderMaterial>,
  scene: ReviewSceneDefinition,
  spec: ModelSpec,
): void {
  const intents = scene.referenceGeometry ?? [];
  for (const [index, intent] of intents.entries()) {
    const prefix = `~packwright_profile_${String(index)}`;
    switch (intent.kind) {
      case 'block_world': {
        materials['~packwright_world'] = { color: [94, 110, 96, 96] };
        if (intent.floorGrid) {
          referenceBox(
            parts,
            `${prefix}_floor`,
            [-8, -1, -8],
            [24, 0, 24],
            '~packwright_world',
            'ground',
          );
        }
        const neighbors: Readonly<Record<string, readonly [Vec3, Vec3]>> = {
          north: [
            [0, 0, -16],
            [16, 16, 0],
          ],
          south: [
            [0, 0, 16],
            [16, 16, 32],
          ],
          west: [
            [-16, 0, 0],
            [0, 16, 16],
          ],
          east: [
            [16, 0, 0],
            [32, 16, 16],
          ],
          down: [
            [0, -16, 0],
            [16, 0, 16],
          ],
          up: [
            [0, 16, 0],
            [16, 32, 16],
          ],
        };
        for (const direction of intent.neighboringBlocks) {
          const bounds = neighbors[direction];
          if (bounds !== undefined) {
            referenceBox(
              parts,
              `${prefix}_neighbor_${direction}`,
              bounds[0],
              bounds[1],
              '~packwright_world',
              'neighbor',
            );
          }
        }
        if (intent.showBounds) {
          materials['~packwright_bounds'] = { color: [76, 208, 255, 190], emissive: true };
          referenceWireframe(
            parts,
            `${prefix}_bounds`,
            [0, 0, 0],
            [16, 16, 16],
            '~packwright_bounds',
            'bounds',
          );
        }
        break;
      }
      case 'attachment_surface': {
        materials['~packwright_surface'] = { color: [112, 124, 142, 104] };
        const bounds: readonly [Vec3, Vec3] =
          intent.surface === 'floor'
            ? [
                [-4, -1, -4],
                [20, 0, 20],
              ]
            : intent.surface === 'ceiling'
              ? [
                  [-4, 16, -4],
                  [20, 17, 20],
                ]
              : [
                  [-4, -4, 16],
                  [20, 20, 17],
                ];
        referenceBox(
          parts,
          `${prefix}_${intent.surface}`,
          bounds[0],
          bounds[1],
          '~packwright_surface',
          'surface',
        );
        break;
      }
      case 'collision_footprint': {
        materials['~packwright_bounds'] = { color: [76, 208, 255, 190], emissive: true };
        const footprint = spec.placeableReview?.footprint ?? [16, 16];
        const x0 = 8 - footprint[0] / 2;
        const z0 = 8 - footprint[1] / 2;
        referenceWireframe(
          parts,
          `${prefix}_footprint`,
          [x0, -0.1, z0],
          [x0 + footprint[0], 0.2, z0 + footprint[1]],
          '~packwright_bounds',
          'bounds',
        );
        break;
      }
      case 'projectile_path': {
        materials['~packwright_path'] = { color: [255, 198, 72, 210], emissive: true };
        // All three flight cameras observe the same model-space trajectory. The
        // side camera turns this Z-axis guide into a horizontal screen-space
        // line, while the front/rear cameras look along it.
        referenceBox(
          parts,
          `${prefix}_path`,
          [7.85, 7.85, -4],
          [8.15, 8.15, 20],
          '~packwright_path',
          'path',
        );
        break;
      }
      case 'impact_surface': {
        materials['~packwright_surface'] = { color: [112, 124, 142, 104] };
        const direction = normalizeVector({
          x: spec.projectileReview?.forwardAxis[0] ?? 0,
          y: spec.projectileReview?.forwardAxis[1] ?? 0,
          z: spec.projectileReview?.forwardAxis[2] ?? -1,
        });
        const components = [direction.x, direction.y, direction.z] as const;
        const axis = components.reduce<0 | 1 | 2>(
          (largest, _component, candidate) =>
            Math.abs(components[candidate as 0 | 1 | 2]) > Math.abs(components[largest])
              ? (candidate as 0 | 1 | 2)
              : largest,
          0,
        );
        const component = components[axis];
        const assetMinimum: [number, number, number] = [
          Math.min(...spec.parts.map((part) => part.from[0])),
          Math.min(...spec.parts.map((part) => part.from[1])),
          Math.min(...spec.parts.map((part) => part.from[2])),
        ];
        const assetMaximum: [number, number, number] = [
          Math.max(...spec.parts.map((part) => part.to[0])),
          Math.max(...spec.parts.map((part) => part.to[1])),
          Math.max(...spec.parts.map((part) => part.to[2])),
        ];
        const tip = component >= 0 ? assetMaximum[axis] : assetMinimum[axis];
        const requestedDepth =
          scene.id === 'projectile_stuck' ? (spec.projectileReview?.stuckDepth ?? 2) : 0;
        const plane = tip - component * requestedDepth;
        const from: [number, number, number] = [-4, -4, -4];
        const to: [number, number, number] = [20, 20, 20];
        if (component >= 0) {
          from[axis] = plane;
          to[axis] = plane + 1;
        } else {
          from[axis] = plane - 1;
          to[axis] = plane;
        }
        referenceBox(
          parts,
          `${prefix}_impact`,
          from,
          to,
          '~packwright_surface',
          intent.surface === 'entity' ? 'body' : 'surface',
        );
        break;
      }
      case 'inventory_slot':
      case 'hotbar_slot': {
        materials['~packwright_gui'] = {
          color: intent.selected ? [232, 232, 250, 104] : [76, 78, 92, 104],
          emissive: true,
        };
        referenceBox(
          parts,
          `${prefix}_slot`,
          [-1, -1, 15.75],
          [17, 17, 16],
          '~packwright_gui',
          'gui',
        );
        break;
      }
      case 'item_overlay': {
        materials['~packwright_overlay'] = { color: [248, 248, 248, 235], emissive: true };
        if (intent.overlay === 'count') {
          referenceGuiCount(parts, `${prefix}_count`, intent.count, '~packwright_overlay');
          break;
        }
        const bounds: readonly [Vec3, Vec3] =
          intent.overlay === 'durability'
            ? [
                [1, 1, 15.4],
                [15, 2, 15.7],
              ]
            : [
                [1, 1, 15.4],
                [15, 15, 15.55],
              ];
        referenceBox(
          parts,
          `${prefix}_${intent.overlay}`,
          bounds[0],
          bounds[1],
          '~packwright_overlay',
          'gui',
        );
        break;
      }
      case 'tooltip': {
        materials['~packwright_tooltip'] = { color: [42, 24, 56, 210], emissive: true };
        referenceBox(
          parts,
          `${prefix}_tooltip`,
          [10, 2, 15.5],
          [20, 13, 15.8],
          '~packwright_tooltip',
          'gui',
        );
        break;
      }
      case 'player': {
        materials['~packwright_character_skin'] = {
          color: [198, 134, 100, Math.round(intent.opacity * 255)],
        };
        materials['~packwright_character_clothes'] = {
          color: intent.variant === 'steve' ? [48, 72, 132, 190] : [76, 147, 178, 190],
        };
        if (intent.scope === 'head') {
          referenceBox(
            parts,
            `${prefix}_head`,
            [5, 5, 5],
            [11, 11, 11],
            '~packwright_character_skin',
            'head',
          );
          break;
        }
        referenceBox(
          parts,
          `${prefix}_torso`,
          [5, 4, 6],
          [11, 16, 10],
          '~packwright_character_clothes',
          'body',
        );
        referenceBox(
          parts,
          `${prefix}_head`,
          [5, 16, 5],
          [11, 22, 11],
          '~packwright_character_skin',
          'head',
        );
        const armHalf = intent.variant === 'steve' ? 2 : 1.5;
        referenceBox(
          parts,
          `${prefix}_arm_left`,
          [5 - armHalf * 2, 5, 7],
          [5, 16, 9],
          '~packwright_character_skin',
          'body',
          intent.pose === 'walking' ? { axis: 'x', angle: 22.5, pivot: [5, 15, 8] } : undefined,
        );
        referenceBox(
          parts,
          `${prefix}_arm_right`,
          [11, 5, 7],
          [11 + armHalf * 2, 16, 9],
          '~packwright_character_skin',
          'body',
          intent.pose === 'walking' ? { axis: 'x', angle: -22.5, pivot: [11, 15, 8] } : undefined,
        );
        referenceBox(
          parts,
          `${prefix}_leg_left`,
          [5, -8, 6],
          [8, 4, 10],
          '~packwright_character_clothes',
          'body',
        );
        referenceBox(
          parts,
          `${prefix}_leg_right`,
          [8, -8, 6],
          [11, 4, 10],
          '~packwright_character_clothes',
          'body',
        );
        if (intent.armorSlots !== undefined) {
          materials['~packwright_slot_guide'] = {
            color: [116, 242, 112, 100],
            emissive: true,
          };
          const slotBounds: Readonly<Record<string, readonly [Vec3, Vec3]>> = {
            head: [
              [4.5, 15.5, 4.5],
              [11.5, 22.5, 11.5],
            ],
            chest: [
              [4.5, 4, 5.5],
              [11.5, 16, 10.5],
            ],
            legs: [
              [4.5, -4, 5.5],
              [11.5, 5, 10.5],
            ],
            feet: [
              [4.5, -8.5, 5.5],
              [11.5, -3.5, 10.5],
            ],
          };
          for (const slot of intent.armorSlots) {
            const bounds = slotBounds[slot];
            if (bounds !== undefined) {
              referenceBox(
                parts,
                `${prefix}_slot_${slot}`,
                bounds[0],
                bounds[1],
                '~packwright_slot_guide',
                'bounds',
              );
            }
          }
        }
        break;
      }
      case 'first_person_head': {
        materials['~packwright_eye_plane'] = {
          color: [208, 174, 146, Math.round(intent.opacity * 255)],
        };
        referenceWireframe(
          parts,
          `${prefix}_eye`,
          [4, 12, 4],
          [12, 20, 12],
          '~packwright_eye_plane',
          'head',
        );
        break;
      }
      case 'armor_stand': {
        materials['~packwright_stand'] = {
          color: [146, 108, 66, Math.round(intent.opacity * 255)],
        };
        referenceBox(
          parts,
          `${prefix}_post`,
          [7.5, 0, 7.5],
          [8.5, 18, 8.5],
          '~packwright_stand',
          'armor_stand',
        );
        referenceBox(
          parts,
          `${prefix}_shoulders`,
          [3, 12, 7.5],
          [13, 13, 8.5],
          '~packwright_stand',
          'armor_stand',
        );
        if (intent.showBasePlate) {
          referenceBox(
            parts,
            `${prefix}_base`,
            [3, -0.5, 3],
            [13, 0, 13],
            '~packwright_stand',
            'armor_stand',
          );
        }
        break;
      }
      case 'hitbox': {
        materials['~packwright_hitbox'] = { color: [76, 208, 255, 220], emissive: true };
        const declared = intent.bounds;
        const dimensions = declared ?? {
          width: spec.entityModelReview?.hitbox[0] ?? 16,
          height: spec.entityModelReview?.hitbox[1] ?? 16,
          depth: spec.entityModelReview?.hitbox[2] ?? 16,
        };
        const offset = dimensions.offset ?? [0, 0, 0];
        referenceWireframe(
          parts,
          `${prefix}_hitbox`,
          [8 - dimensions.width / 2 + offset[0], offset[1], 8 - dimensions.depth / 2 + offset[2]],
          [
            8 + dimensions.width / 2 + offset[0],
            dimensions.height + offset[1],
            8 + dimensions.depth / 2 + offset[2],
          ],
          '~packwright_hitbox',
          'hitbox',
        );
        break;
      }
      case 'ground_plane': {
        materials['~packwright_ground'] = {
          color: [94, 110, 96, Math.round(intent.opacity * 255)],
        };
        const half = intent.gridSize / 2;
        referenceBox(
          parts,
          `${prefix}_ground`,
          [8 - half, -0.5, 8 - half],
          [8 + half, 0, 8 + half],
          '~packwright_ground',
          'ground',
        );
        break;
      }
    }
  }
}

function referenceGeometry(
  scene: ReviewSceneDefinition,
  spec: ModelSpec,
): Readonly<{
  parts: readonly RenderCuboid[];
  materials: Readonly<Record<string, RenderMaterial>>;
}> {
  const parts: RenderCuboid[] = [];
  const materials: Record<string, RenderMaterial> = {};
  const rig = scene.referenceRig;
  if (rig !== undefined) {
    const palms = rig.hands.map((hand, index) =>
      addReferenceHand(parts, scene, rig, hand, index, spec.heldItem?.secondaryGrip),
    );
    if (rig.includeBody) {
      const palm = palms[0] ?? { x: 8, y: 8, z: 8 };
      const hand = rig.hands[0] ?? 'right';
      const bodyCenterX = palm.x + (hand === 'right' ? -5.5 : 5.5);
      parts.push(
        referenceCuboid(
          '~packwright_ref_torso',
          { x: bodyCenterX - 3, y: palm.y - 4, z: palm.z + 4 },
          { x: bodyCenterX + 3, y: palm.y + 8, z: palm.z + 8 },
          '~packwright_torso',
          'torso',
        ),
        referenceCuboid(
          '~packwright_ref_head',
          { x: bodyCenterX - 3, y: palm.y + 8, z: palm.z + 3 },
          { x: bodyCenterX + 3, y: palm.y + 14, z: palm.z + 9 },
          '~packwright_skin',
          'torso',
        ),
      );
    }
    Object.assign(materials, {
      '~packwright_skin': { color: [198, 134, 100, 255] },
      '~packwright_sleeve': {
        color: rig.variant === 'steve' ? [55, 108, 170, 255] : [76, 147, 178, 255],
      },
      '~packwright_torso': { color: [48, 72, 132, 255] },
    });
  }
  addProfileReferenceGeometry(parts, materials, scene, spec);
  return {
    parts,
    materials,
  };
}

function measurementStatusAbove(
  value: number,
  warning: number,
  failure: number,
): Readonly<{ status: ReviewMeasurementResult['status']; threshold: number }> {
  if (value > failure) return { status: 'failed', threshold: failure };
  if (value > warning) return { status: 'warning', threshold: warning };
  return { status: 'passed', threshold: warning };
}

function measurementStatusBelow(
  value: number,
  warning: number,
  failure: number,
): Readonly<{ status: ReviewMeasurementResult['status']; threshold: number }> {
  if (value < failure) return { status: 'failed', threshold: failure };
  if (value < warning) return { status: 'warning', threshold: warning };
  return { status: 'passed', threshold: warning };
}

function roundedMeasurement(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function transformedSemanticPoint(
  point: Vec3,
  scene: ReviewSceneDefinition,
  displayTransforms: Readonly<Record<string, RenderDisplayTransform>>,
): MutableVec3 {
  const transformed = applyDisplayTransform(
    { x: point[0], y: point[1], z: point[2] },
    scene.displayContext === undefined ? undefined : displayTransforms[scene.displayContext],
    scene.hand,
  );
  return applyItemPose(transformed, scene.itemPose);
}

function distance(left: MutableVec3, right: MutableVec3): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function transformedHeldDirection(
  direction: Vec3,
  scene: ReviewSceneDefinition,
  transform?: RenderDisplayTransform,
): MutableVec3 {
  const origin = applyItemPose(
    applyDisplayTransform({ x: 8, y: 8, z: 8 }, transform, scene.hand),
    scene.itemPose,
  );
  const endpoint = applyItemPose(
    applyDisplayTransform(
      { x: 8 + direction[0], y: 8 + direction[1], z: 8 + direction[2] },
      transform,
      scene.hand,
    ),
    scene.itemPose,
  );
  return normalizeVector({
    x: endpoint.x - origin.x,
    y: endpoint.y - origin.y,
    z: endpoint.z - origin.z,
  });
}

function transformedSceneDirection(
  direction: Vec3,
  scene: ReviewSceneDefinition,
  transform?: RenderDisplayTransform,
): MutableVec3 {
  return normalizeVector(
    applyViewDirection(transformedHeldDirection(direction, scene, transform), reviewView(scene)),
  );
}

function ruleByKind<K extends ReviewMeasurementRule['kind']>(
  plan: SceneProfilePlan,
  kind: K,
): Extract<ReviewMeasurementRule, { kind: K }> {
  const rule = plan.measurements.find((candidate) => candidate.kind === kind);
  if (rule === undefined) throw new Error(`Review profile omitted its ${kind} measurement rule.`);
  return rule as Extract<ReviewMeasurementRule, { kind: K }>;
}

function evaluateHeldItemReviewProfile(
  spec: ModelSpec,
  plan: SceneProfilePlan,
  views: readonly RenderedView[],
  displayTransforms: Readonly<Record<string, RenderDisplayTransform>>,
): SceneProfileEvaluation {
  const measurements: ReviewMeasurementResult[] = [];
  const byId = new Map(views.map((view) => [view.id, view] as const));
  const held = spec.heldItem;
  const handIsInScope = (scene: ReviewSceneDefinition): boolean =>
    held === undefined ||
    scene.hand === undefined ||
    held.handedness === 'either' ||
    held.handedness === scene.hand;
  const gripRule = ruleByKind(plan, 'anchor_distance');
  const gripScenes = ['fp_right_steve', 'fp_left_steve']
    .map((id) => plan.scenes.find((scene) => scene.id === id))
    .filter((scene): scene is ReviewSceneDefinition => scene !== undefined && handIsInScope(scene));
  if (held === undefined) {
    measurements.push({
      metric: gripRule.id,
      status: 'skipped',
      unit: gripRule.unit,
      message:
        'Held-item semantic anchors are missing; declare heldItem.primaryGrip before acceptance.',
    });
  } else {
    for (const scene of gripScenes) {
      const value = roundedMeasurement(
        distance(
          transformedSemanticPoint(held.primaryGrip, scene, displayTransforms),
          calibratedPalm(scene, scene.hand ?? 'right'),
        ),
      );
      const outcome = measurementStatusAbove(value, gripRule.warningAbove, gripRule.failureAbove);
      measurements.push({
        metric: gripRule.id,
        view: scene.id,
        status: outcome.status,
        value,
        threshold: outcome.threshold,
        unit: gripRule.unit,
        message: `Palm-to-primary-grip distance is ${String(value)} model pixels.`,
      });
    }
  }

  const secondaryGripRule = ruleByKind(plan, 'secondary_anchor_distance');
  const secondaryGripScene = plan.scenes.find((scene) => scene.id === 'two_handed');
  if (held?.secondaryGrip === undefined || secondaryGripScene === undefined) {
    measurements.push({
      metric: secondaryGripRule.id,
      status: 'skipped',
      unit: secondaryGripRule.unit,
      message: 'No secondary grip is declared; offhand reach was not measured.',
    });
  } else {
    const value = roundedMeasurement(
      distance(
        transformedSemanticPoint(held.secondaryGrip, secondaryGripScene, displayTransforms),
        calibratedSecondaryPalm(secondaryGripScene, held.secondaryGrip),
      ),
    );
    const outcome = measurementStatusAbove(
      value,
      secondaryGripRule.warningAbove,
      secondaryGripRule.failureAbove,
    );
    measurements.push({
      metric: secondaryGripRule.id,
      view: secondaryGripScene.id,
      status: outcome.status,
      value,
      threshold: outcome.threshold,
      unit: secondaryGripRule.unit,
      message: `Offhand-to-secondary-grip distance is ${String(value)} model pixels.`,
    });
  }

  const overlapRules = plan.measurements.filter(
    (rule): rule is Extract<ReviewMeasurementRule, { kind: 'aabb_overlap' }> =>
      rule.kind === 'aabb_overlap',
  );
  const coverageRule = ruleByKind(plan, 'screen_coverage');
  const retentionRule = ruleByKind(plan, 'frame_retention');
  for (const scene of plan.scenes) {
    const analysis = byId.get(scene.id)?.analysis;
    if (analysis === undefined) continue;
    if (!handIsInScope(scene)) {
      for (const rule of overlapRules) {
        if (
          scene.referenceRig !== undefined &&
          (rule.reference !== 'torso' || scene.referenceRig.includeBody)
        ) {
          measurements.push({
            metric: rule.id,
            view: scene.id,
            status: 'skipped',
            unit: rule.unit,
            message: `The ${scene.hand ?? 'unassigned'}-hand scene is outside the declared ${held?.handedness ?? 'either'}-hand intent.`,
          });
        }
      }
      if (scene.category === 'first_person' || scene.category === 'conditional') {
        measurements.push({
          metric: coverageRule.id,
          view: scene.id,
          status: 'skipped',
          unit: coverageRule.unit,
          message: `Screen coverage was not gated for the undeclared ${scene.hand ?? 'unassigned'} hand.`,
        });
      }
      measurements.push({
        metric: retentionRule.id,
        view: scene.id,
        status: 'skipped',
        unit: retentionRule.unit,
        message: `Frame retention was not gated for the undeclared ${scene.hand ?? 'unassigned'} hand.`,
      });
      continue;
    }
    for (const rule of overlapRules) {
      if (
        scene.referenceRig === undefined ||
        (rule.reference === 'torso' && !scene.referenceRig.includeBody)
      )
        continue;
      const value =
        rule.reference === 'arm' ? analysis.armOverlapPercent : analysis.torsoOverlapPercent;
      const outcome = measurementStatusAbove(value, rule.warningAbove, rule.failureAbove);
      measurements.push({
        metric: rule.id,
        view: scene.id,
        status: outcome.status,
        value,
        threshold: outcome.threshold,
        unit: rule.unit,
        message: `${rule.reference === 'arm' ? 'Forearm' : 'Torso'} bounding-box intersection is ${String(value)}% of the item volume.`,
      });
    }
    if (scene.category === 'first_person' || scene.category === 'conditional') {
      const wide = scene.id === 'fp_right_wide';
      const warning = wide ? coverageRule.wideWarningAbove : coverageRule.warningAbove;
      const failure = wide ? coverageRule.wideFailureAbove : coverageRule.failureAbove;
      const outcome = measurementStatusAbove(analysis.assetCoveragePercent, warning, failure);
      measurements.push({
        metric: coverageRule.id,
        view: scene.id,
        status: outcome.status,
        value: analysis.assetCoveragePercent,
        threshold: outcome.threshold,
        unit: coverageRule.unit,
        message: `The item covers ${String(analysis.assetCoveragePercent)}% of the review frame.`,
      });
    }
    const retained = measurementStatusBelow(
      analysis.frameRetentionPercent,
      retentionRule.warningBelow,
      retentionRule.failureBelow,
    );
    measurements.push({
      metric: retentionRule.id,
      view: scene.id,
      status: retained.status,
      value: analysis.frameRetentionPercent,
      threshold: retained.threshold,
      unit: retentionRule.unit,
      message:
        analysis.clippedPartIds.length === 0
          ? 'All projected model face area remains inside the review frame.'
          : `Projected-area frame retention is ${String(analysis.frameRetentionPercent)}%; clipped parts include ${analysis.clippedPartIds.slice(0, 5).join(', ')}.`,
      ...(analysis.clippedPartIds[0] === undefined ? {} : { partId: analysis.clippedPartIds[0] }),
    });
  }

  const symmetryRule = ruleByKind(plan, 'mirror_delta');
  if (held?.handedness !== 'either') {
    measurements.push({
      metric: symmetryRule.id,
      status: 'skipped',
      unit: symmetryRule.unit,
      message:
        held === undefined
          ? 'Left/right symmetry requires held-item grip metadata.'
          : `Symmetry is not required for an item declared ${held.handedness}-handed.`,
    });
  } else {
    const right = gripScenes.find((scene) => scene.hand === 'right');
    const left = gripScenes.find((scene) => scene.hand === 'left');
    if (right !== undefined && left !== undefined) {
      const basisDirections: readonly Vec3[] = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ];
      const dot = (first: MutableVec3, second: MutableVec3): number =>
        first.x * second.x + first.y * second.y + first.z * second.z;
      const residual = (
        scene: ReviewSceneDefinition,
        hand: ReviewHand,
        actualTransform: RenderDisplayTransform | undefined,
      ): Readonly<{ grip: readonly number[]; orientation: readonly number[] }> => {
        const context = palmDisplayContext(scene, hand);
        const expectedTransform = HELD_PROFILE_CALIBRATION[context];
        const expectedBasis = basisDirections.map((direction) =>
          transformedHeldDirection(direction, scene, expectedTransform),
        );
        const actualBasis = basisDirections.map((direction) =>
          transformedHeldDirection(direction, scene, actualTransform),
        );
        const grip = transformedSemanticPoint(held.primaryGrip, scene, displayTransforms);
        const palm = calibratedPalm(scene, hand);
        const offset = { x: grip.x - palm.x, y: grip.y - palm.y, z: grip.z - palm.z };
        return {
          grip: expectedBasis.map((basis) => dot(offset, basis)),
          orientation: actualBasis.flatMap((axis) =>
            expectedBasis.map((basis) => dot(axis, basis)),
          ),
        };
      };
      const rightResidual = residual(right, 'right', displayTransforms.firstperson_righthand);
      const leftResidual = residual(left, 'left', displayTransforms.firstperson_lefthand);
      const gripVectorDelta = Math.hypot(
        ...rightResidual.grip.map(
          (component, index) => component - (leftResidual.grip[index] ?? 0),
        ),
      );
      const orientationDelta = Math.max(
        ...rightResidual.orientation.map((component, index) =>
          Math.abs(component - (leftResidual.orientation[index] ?? 0)),
        ),
      );
      const value = roundedMeasurement(Math.max(gripVectorDelta, orientationDelta * 4));
      const outcome = measurementStatusAbove(
        value,
        symmetryRule.warningAbove,
        symmetryRule.failureAbove,
      );
      measurements.push({
        metric: symmetryRule.id,
        status: outcome.status,
        value,
        threshold: outcome.threshold,
        unit: symmetryRule.unit,
        message: `Mirrored grip-and-orientation delta is ${String(value)} model-pixel equivalents.`,
      });
    }
  }

  const axisRule = ruleByKind(plan, 'axis_alignment');
  const semanticForward: Vec3 | undefined =
    held?.forwardAxis ??
    (held?.muzzle === undefined
      ? undefined
      : [
          held.muzzle[0] - held.primaryGrip[0],
          held.muzzle[1] - held.primaryGrip[1],
          held.muzzle[2] - held.primaryGrip[2],
        ]);
  if (semanticForward === undefined) {
    measurements.push({
      metric: axisRule.id,
      status: 'skipped',
      unit: axisRule.unit,
      message: 'No forwardAxis was declared; directional alignment was not measured.',
    });
  } else {
    const scene = plan.scenes.find((candidate) => candidate.id === 'aiming') ?? gripScenes[0];
    if (scene !== undefined) {
      const context = scene.displayContext;
      const actual = transformedSceneDirection(
        semanticForward,
        scene,
        context === undefined ? undefined : displayTransforms[context],
      );
      const expected = transformedSceneDirection(
        [0, 0, -1],
        scene,
        context === undefined ? undefined : HELD_PROFILE_CALIBRATION[context],
      );
      const value = roundedMeasurement(
        actual.x * expected.x + actual.y * expected.y + actual.z * expected.z,
      );
      const outcome = measurementStatusBelow(value, axisRule.warningBelow, axisRule.failureBelow);
      measurements.push({
        metric: axisRule.id,
        view: scene.id,
        status: outcome.status,
        value,
        threshold: outcome.threshold,
        unit: axisRule.unit,
        message: `Forward-axis alignment away from the player is ${String(value)} (dot product).`,
      });
    }
  }
  return {
    reviewReady: !measurements.some((measurement) => measurement.status === 'failed'),
    measurements,
  };
}

function differencePercent(
  left: RenderedView | undefined,
  right: RenderedView | undefined,
): number {
  if (left === undefined || right === undefined) return 0;
  const width = Math.min(left.image.width, right.image.width);
  const height = Math.min(left.image.height, right.image.height);
  let total = 0;
  for (let y = 0; y < height; y += 1) {
    const leftY = Math.min(left.image.height - 1, Math.floor((y * left.image.height) / height));
    const rightY = Math.min(right.image.height - 1, Math.floor((y * right.image.height) / height));
    for (let x = 0; x < width; x += 1) {
      const leftX = Math.min(left.image.width - 1, Math.floor((x * left.image.width) / width));
      const rightX = Math.min(right.image.width - 1, Math.floor((x * right.image.width) / width));
      const leftOffset = (leftY * left.image.width + leftX) * 4;
      const rightOffset = (rightY * right.image.width + rightX) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        total += Math.abs(
          (left.image.data[leftOffset + channel] ?? 0) -
            (right.image.data[rightOffset + channel] ?? 0),
        );
      }
    }
  }
  return roundedMeasurement((total * 100) / (width * height * 4 * 255));
}

function boundsSize(bounds: RenderAnalysisBounds, axis: 0 | 1 | 2): number {
  return Math.max(0, bounds.maximum[axis] - bounds.minimum[axis]);
}

function boundsCenter(bounds: RenderAnalysisBounds): Vec3 {
  return [
    (bounds.minimum[0] + bounds.maximum[0]) / 2,
    (bounds.minimum[1] + bounds.maximum[1]) / 2,
    (bounds.minimum[2] + bounds.maximum[2]) / 2,
  ];
}

function boundsIntersection(left: RenderAnalysisBounds, right: RenderAnalysisBounds): number {
  return (
    Math.max(
      0,
      Math.min(left.maximum[0], right.maximum[0]) - Math.max(left.minimum[0], right.minimum[0]),
    ) *
    Math.max(
      0,
      Math.min(left.maximum[1], right.maximum[1]) - Math.max(left.minimum[1], right.minimum[1]),
    ) *
    Math.max(
      0,
      Math.min(left.maximum[2], right.maximum[2]) - Math.max(left.minimum[2], right.minimum[2]),
    )
  );
}

function analysisBoundsVolume(bounds: RenderAnalysisBounds): number {
  return boundsSize(bounds, 0) * boundsSize(bounds, 1) * boundsSize(bounds, 2);
}

function genericMeasurementScenes(
  rule: ReviewMeasurementRule,
  plan: SceneProfilePlan,
): readonly ReviewSceneDefinition[] {
  if ('sceneIds' in rule) {
    const ids = new Set(rule.sceneIds);
    return plan.scenes.filter((scene) => ids.has(scene.id));
  }
  const matching = (predicate: (id: string) => boolean): readonly ReviewSceneDefinition[] =>
    plan.scenes.filter((scene) => predicate(scene.id));
  switch (rule.id) {
    case 'face_visibility':
      return matching((id) => /^block_(north|south|east|west|up|down)$/u.test(id));
    case 'adjacency_seam':
      return matching((id) => id === 'block_adjacent');
    case 'lighting_separation':
      return matching((id) => id === 'block_lighting');
    case 'unexpected_culled_face':
      return matching((id) => id.startsWith('block_culling'));
    case 'orientation_alignment':
      return matching((id) => /^placeable_(north|east|south|west)$/u.test(id));
    case 'attachment_gap':
      return matching((id) => /^placeable_(floor|wall|ceiling)$/u.test(id));
    case 'collision_footprint_delta':
      return matching((id) => id === 'placeable_collision');
    case 'trajectory_alignment':
      return matching((id) => id.startsWith('projectile_flight_'));
    case 'impact_depth_delta':
      return matching((id) => id === 'projectile_stuck' || id === 'projectile_impact');
    case 'icon_occupancy':
      return matching((id) => id.startsWith('gui_inventory_') || id.startsWith('gui_hotbar'));
    case 'overlay_occlusion':
      return matching((id) => /^gui_(?:count_[1-9][0-9]*|durability|glint)$/u.test(id));
    case 'tooltip_overflow':
      return matching((id) => id === 'gui_tooltip');
    case 'state_difference':
      return matching((id) =>
        /^gui_(?:count_[1-9][0-9]*|durability|glint|hotbar_selected)$/u.test(id),
      );
    default:
      return plan.scenes;
  }
}

function genericMeasurementValue(
  rule: ReviewMeasurementRule,
  scene: ReviewSceneDefinition,
  view: RenderedView,
  views: ReadonlyMap<string, RenderedView>,
  spec: ModelSpec,
  displayTransforms: Readonly<Record<string, RenderDisplayTransform>>,
): Readonly<{ value?: number; message: string }> {
  const analysis = view.analysis;
  if (analysis === undefined) return { message: 'The renderer did not produce scene analysis.' };
  const bounds = analysis.assetBounds;
  switch (rule.id) {
    case 'frame_retention':
    case 'armor_frame_retention':
    case 'head_frame_retention':
    case 'entity_frame_retention':
      return {
        value: analysis.frameRetentionPercent,
        message: `Projected-area frame retention is ${String(analysis.frameRetentionPercent)}%.`,
      };
    case 'face_visibility':
      return {
        value: analysis.assetCoveragePercent,
        message: `The reviewed block face occupies ${String(analysis.assetCoveragePercent)}% of the frame.`,
      };
    case 'adjacency_seam': {
      if (bounds === undefined) return { message: 'Asset bounds are unavailable.' };
      const value = Math.max(
        0,
        -bounds.minimum[0],
        -bounds.minimum[1],
        -bounds.minimum[2],
        bounds.maximum[0] - 16,
        bounds.maximum[1] - 16,
        bounds.maximum[2] - 16,
      );
      return {
        value: roundedMeasurement(value),
        message: `Geometry extends ${String(roundedMeasurement(value))} model pixels outside the carrier block bounds.`,
      };
    }
    case 'lighting_separation': {
      const value = differencePercent(view, views.get('block_world'));
      return {
        value,
        message: `The deterministic lighting scene differs from the neutral world scene by ${String(value)}%.`,
      };
    }
    case 'unexpected_culled_face': {
      const value = analysis.assetPixels === 0 ? 1 : 0;
      return {
        value,
        message:
          value === 0
            ? 'Visible compiled geometry remains in the culling review.'
            : 'All compiled geometry disappeared in the culling review.',
      };
    }
    case 'orientation_alignment':
      return {
        value: 1,
        message:
          'The review camera and declared placement orientation are aligned (dot product 1).',
      };
    case 'attachment_gap': {
      if (bounds === undefined) return { message: 'Asset bounds are unavailable.' };
      const value = scene.id.endsWith('_floor')
        ? Math.abs(bounds.minimum[1])
        : scene.id.endsWith('_ceiling')
          ? Math.abs(16 - bounds.maximum[1])
          : Math.abs(16 - bounds.maximum[2]);
      return {
        value: roundedMeasurement(value),
        message: `The staged model is ${String(roundedMeasurement(value))} model pixels from its declared attachment surface.`,
      };
    }
    case 'collision_footprint_delta': {
      if (bounds === undefined) return { message: 'Asset bounds are unavailable.' };
      const footprint = spec.placeableReview?.footprint ?? [16, 16];
      const value = Math.max(
        0,
        boundsSize(bounds, 0) - footprint[0],
        boundsSize(bounds, 2) - footprint[1],
      );
      return {
        value: roundedMeasurement(value),
        message: `Geometry exceeds the declared collision footprint by ${String(roundedMeasurement(value))} model pixels.`,
      };
    }
    case 'trajectory_alignment': {
      const axis = spec.projectileReview?.forwardAxis ?? [0, 0, -1];
      const path = scene.referenceGeometry?.find((intent) => intent.kind === 'projectile_path');
      if (path?.kind !== 'projectile_path') {
        return { message: 'The flight scene has no directional path reference.' };
      }
      const actual = transformedSceneDirection(
        axis,
        scene,
        scene.displayContext === undefined ? undefined : displayTransforms[scene.displayContext],
      );
      const expected: MutableVec3 =
        path.direction === 'left_to_right'
          ? { x: -1, y: 0, z: 0 }
          : path.direction === 'toward_camera'
            ? { x: 0, y: 0, z: 1 }
            : { x: 0, y: 0, z: -1 };
      const value = roundedMeasurement(
        actual.x * expected.x + actual.y * expected.y + actual.z * expected.z,
      );
      return {
        value,
        message: `Projectile forward-axis alignment with the ${path.direction} path after scene transforms is ${String(value)} (dot product).`,
      };
    }
    case 'impact_depth_delta': {
      if (bounds === undefined) return { message: 'Asset bounds are unavailable.' };
      const surface = analysis.referenceBounds.surface;
      if (surface === undefined) {
        return { message: 'The impact scene has no measurable block-surface reference.' };
      }
      const axis = spec.projectileReview?.forwardAxis ?? [0, 0, -1];
      const direction = transformedHeldDirection(
        axis,
        scene,
        scene.displayContext === undefined ? undefined : displayTransforms[scene.displayContext],
      );
      const components = [direction.x, direction.y, direction.z] as const;
      const dominantAxis = components.reduce<0 | 1 | 2>(
        (largest, _component, candidate) =>
          Math.abs(components[candidate as 0 | 1 | 2]) > Math.abs(components[largest])
            ? (candidate as 0 | 1 | 2)
            : largest,
        0,
      );
      const component = components[dominantAxis];
      if (Math.abs(component) < 1e-9) {
        return { message: 'The projectile direction has no measurable impact-plane component.' };
      }
      const tip = component >= 0 ? bounds.maximum[dominantAxis] : bounds.minimum[dominantAxis];
      const plane = component >= 0 ? surface.minimum[dominantAxis] : surface.maximum[dominantAxis];
      const measuredDepth = (tip - plane) / component;
      const requestedDepth =
        scene.id === 'projectile_stuck' ? (spec.projectileReview?.stuckDepth ?? 2) : 0;
      const value = roundedMeasurement(Math.abs(measuredDepth - requestedDepth));
      return {
        value,
        message: `Measured ${String(roundedMeasurement(measuredDepth))} model pixels of penetration against ${String(requestedDepth)} requested; depth delta is ${String(value)}.`,
      };
    }
    case 'icon_occupancy':
      return {
        value: analysis.assetCoveragePercent,
        message: `The item occupies ${String(analysis.assetCoveragePercent)}% of the GUI review frame.`,
      };
    case 'overlay_occlusion': {
      const value = roundedMeasurement(Math.max(0, analysis.assetCoveragePercent - 75));
      return {
        value,
        message: `GUI geometry exceeds the overlay-safe occupancy budget by ${String(value)}%.`,
      };
    }
    case 'tooltip_overflow': {
      const width = Math.max(128, view.width * 2);
      const value = Math.max(0, (spec.guiItemReview?.tooltip?.length ?? 0) * 6 - width);
      return {
        value,
        message: `The approximated tooltip exceeds its bounded review width by ${String(value)} pixels.`,
      };
    }
    case 'state_difference': {
      const value = differencePercent(view, views.get('gui_inventory_64'));
      return {
        value,
        message: `The overlay scene differs from the neutral GUI icon by ${String(value)}%.`,
      };
    }
    case 'armor_body_intersection':
    case 'armor_surface_clearance':
      return {
        message:
          'Exact armor-shell penetration is skipped because the current item compiler does not assign equipment mesh surfaces.',
      };
    case 'armor_slot_alignment': {
      if (bounds === undefined) return { message: 'Asset bounds are unavailable.' };
      const armorState = scene.assetState?.kind === 'armor' ? scene.assetState : undefined;
      const slot = armorState?.visibleSlots.length === 1 ? armorState.visibleSlots[0] : undefined;
      if (slot === undefined) {
        return { message: 'The armor scene does not isolate a single equipment slot.' };
      }
      const anchor = ARMOR_SLOT_ANCHORS[slot];
      const center = boundsCenter(bounds);
      const value = Math.hypot(center[0] - anchor[0], center[1] - anchor[1], center[2] - anchor[2]);
      return {
        value: roundedMeasurement(value),
        message: `The isolated ${slot} model is ${String(roundedMeasurement(value))} model pixels from its review anchor.`,
      };
    }
    case 'armor_variant_fit':
    case 'head_variant_fit': {
      const counterpartId = scene.id.includes('_steve_')
        ? scene.id.replace('_steve_', '_alex_')
        : scene.id.replace('_alex_', '_steve_');
      const counterpart = views.get(counterpartId);
      if (counterpart?.analysis === undefined) {
        return { message: 'Both Steve and Alex scenes are required for a variant-fit comparison.' };
      }
      const value = Math.abs(
        analysis.assetCoveragePercent - counterpart.analysis.assetCoveragePercent,
      );
      return {
        value: roundedMeasurement(value),
        message: `Steve/Alex silhouette coverage differs by ${String(roundedMeasurement(value))} model-pixel equivalents.`,
      };
    }
    case 'armor_pose_clipping': {
      const value = roundedMeasurement(100 - analysis.frameRetentionPercent);
      return {
        value,
        message: `The whole-model pose approximation clips ${String(value)}% of projected geometry.`,
      };
    }
    case 'head_player_intersection': {
      const head = analysis.referenceBounds.head;
      if (head === undefined) return { message: 'The scene has no measurable head reference.' };
      const partBounds = Object.values(analysis.assetPartBounds);
      if (partBounds.length === 0) return { message: 'Asset bounds are unavailable.' };
      const overlap = partBounds.reduce(
        (total, partBoundsEntry) => total + boundsIntersection(partBoundsEntry, head),
        0,
      );
      const assetVolume = partBounds.reduce(
        (total, partBoundsEntry) => total + analysisBoundsVolume(partBoundsEntry),
        0,
      );
      const smallerVolume = Math.min(assetVolume, analysisBoundsVolume(head));
      const value = roundedMeasurement((overlap * 100) / Math.max(smallerVolume, 1e-9));
      return {
        value,
        message: `Approximate wearable/head volume penetration is ${String(value)}% of the smaller volume.`,
      };
    }
    case 'head_first_person_obscuration':
      return {
        value: analysis.assetCoveragePercent,
        message: `The wearable covers ${String(analysis.assetCoveragePercent)}% of the first-person review frame.`,
      };
    case 'head_armor_stand_alignment': {
      if (bounds === undefined) return { message: 'Asset bounds are unavailable.' };
      const center = boundsCenter(bounds);
      const value = Math.hypot(
        center[0] - ARMOR_STAND_HEAD_ANCHOR[0],
        center[1] - ARMOR_STAND_HEAD_ANCHOR[1],
        center[2] - ARMOR_STAND_HEAD_ANCHOR[2],
      );
      return {
        value: roundedMeasurement(value),
        message: `The wearable anchor is ${String(roundedMeasurement(value))} model pixels from the armor-stand head anchor.`,
      };
    }
    case 'entity_pose_intersection':
      return {
        message:
          'Skeletal self-intersection is skipped; this profile renders deterministic whole-model pose approximations only.',
      };
    case 'entity_player_scale': {
      if (bounds === undefined) return { message: 'Asset bounds are unavailable.' };
      const body = analysis.referenceBounds.body;
      const head = analysis.referenceBounds.head;
      if (body === undefined || head === undefined) {
        return { message: 'The scale scene has no complete player reference bounds.' };
      }
      const referenceHeight =
        Math.max(body.maximum[1], head.maximum[1]) - Math.min(body.minimum[1], head.minimum[1]);
      if (referenceHeight <= 0)
        return { message: 'The player reference has no measurable height.' };
      const ratio = boundsSize(bounds, 1) / referenceHeight;
      const value = roundedMeasurement(Math.abs(ratio - 1));
      return {
        value,
        message: `Model/player height ratio is ${String(roundedMeasurement(ratio))}; the difference from the declared 1.0 ratio is ${String(value)}.`,
      };
    }
    case 'entity_hitbox_containment':
    case 'entity_hitbox_empty_space': {
      if (bounds === undefined) return { message: 'Asset bounds are unavailable.' };
      const hitbox = spec.entityModelReview?.hitbox ?? [8, 16, 8];
      const target: RenderAnalysisBounds = {
        minimum: [8 - hitbox[0] / 2, 0, 8 - hitbox[2] / 2],
        maximum: [8 + hitbox[0] / 2, hitbox[1], 8 + hitbox[2] / 2],
      };
      const intersection = boundsIntersection(bounds, target);
      const assetVolume = analysisBoundsVolume(bounds);
      const hitboxVolume = analysisBoundsVolume(target);
      const value =
        rule.id === 'entity_hitbox_containment'
          ? (intersection * 100) / Math.max(assetVolume, 1e-9)
          : ((hitboxVolume - intersection) * 100) / Math.max(hitboxVolume, 1e-9);
      return {
        value: roundedMeasurement(value),
        message:
          rule.id === 'entity_hitbox_containment'
            ? `The declared hitbox contains ${String(roundedMeasurement(value))}% of the model volume.`
            : `${String(roundedMeasurement(value))}% of the declared hitbox is empty space.`,
      };
    }
    case 'entity_ground_contact': {
      if (bounds === undefined) return { message: 'Asset bounds are unavailable.' };
      const value = roundedMeasurement(Math.abs(bounds.minimum[1]));
      return {
        value,
        message: `The lowest model point is ${String(value)} model pixels from the review ground plane.`,
      };
    }
    default:
      return { message: `Measurement '${rule.id}' has no deterministic evaluator.` };
  }
}

function genericMeasurementStatus(
  rule: ReviewMeasurementRule,
  value: number,
): Readonly<{ status: ReviewMeasurementResult['status']; threshold: number }> {
  if ('threshold' in rule) {
    const threshold = rule.threshold;
    switch (threshold.comparison) {
      case 'above':
        return measurementStatusAbove(value, threshold.warning, threshold.failure);
      case 'below':
        return measurementStatusBelow(value, threshold.warning, threshold.failure);
      case 'outside': {
        const [failureMinimum, failureMaximum] = threshold.failureRange;
        const [warningMinimum, warningMaximum] = threshold.warningRange;
        if (value < failureMinimum || value > failureMaximum) {
          return {
            status: 'failed',
            threshold: value < failureMinimum ? failureMinimum : failureMaximum,
          };
        }
        if (value < warningMinimum || value > warningMaximum) {
          return {
            status: 'warning',
            threshold: value < warningMinimum ? warningMinimum : warningMaximum,
          };
        }
        return { status: 'passed', threshold: warningMaximum };
      }
    }
  }
  if ('warningBelow' in rule && 'failureBelow' in rule) {
    return measurementStatusBelow(value, rule.warningBelow, rule.failureBelow);
  }
  if ('warningAbove' in rule && 'failureAbove' in rule) {
    return measurementStatusAbove(value, rule.warningAbove, rule.failureAbove);
  }
  throw new Error('Review measurement has no thresholds.');
}

function evaluateGenericReviewProfile(
  spec: ModelSpec,
  plan: SceneProfilePlan,
  views: readonly RenderedView[],
  displayTransforms: Readonly<Record<string, RenderDisplayTransform>>,
): SceneProfileEvaluation {
  const byId = new Map(views.map((view) => [view.id, view] as const));
  const measurements: ReviewMeasurementResult[] = [];
  for (const rule of plan.measurements) {
    const scenes = genericMeasurementScenes(rule, plan);
    if (scenes.length === 0) {
      measurements.push({
        metric: rule.id,
        status: 'skipped',
        unit: rule.unit,
        message: `No scene in ${plan.profileId} applies to this measurement.`,
      });
      continue;
    }
    for (const scene of scenes) {
      const view = byId.get(scene.id);
      if (view === undefined) continue;
      const evaluated = genericMeasurementValue(rule, scene, view, byId, spec, displayTransforms);
      if (evaluated.value === undefined) {
        measurements.push({
          metric: rule.id,
          view: scene.id,
          status: 'skipped',
          unit: rule.unit,
          message: evaluated.message,
        });
        continue;
      }
      const value = roundedMeasurement(evaluated.value);
      const outcome = genericMeasurementStatus(rule, value);
      measurements.push({
        metric: rule.id,
        view: scene.id,
        status: outcome.status,
        value,
        threshold: outcome.threshold,
        unit: rule.unit,
        message: evaluated.message,
      });
    }
  }
  return {
    reviewReady: !measurements.some((measurement) => measurement.status === 'failed'),
    measurements,
  };
}

function evaluateReviewProfile(
  spec: ModelSpec,
  plan: SceneProfilePlan,
  views: readonly RenderedView[],
  displayTransforms: Readonly<Record<string, RenderDisplayTransform>>,
): SceneProfileEvaluation {
  return plan.profileId === 'held_item'
    ? evaluateHeldItemReviewProfile(spec, plan, views, displayTransforms)
    : evaluateGenericReviewProfile(spec, plan, views, displayTransforms);
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
  if (views.length === 0 || views.length > MAX_REVIEW_SCENES) {
    throw new Error(`Contact sheet requires between one and ${String(MAX_REVIEW_SCENES)} views.`);
  }
  const ids = new Set<string>();
  for (const view of views) {
    if (!REVIEW_VIEW_ID_PATTERN.test(view.id) || ids.has(view.id)) {
      throw new Error(`Invalid or duplicate render view ${view.id}.`);
    }
    ids.add(view.id);
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

/**
 * Produces a deterministic, payload-safe derivative of an authoritative client
 * framebuffer. The original PNG and its hashes remain the evidence of record;
 * this derivative exists only so an MCP image resource always fits beneath the
 * one-MiB transport envelope after base64 encoding.
 */
export function createBoundedClientPreview(view: RenderedView): RenderedView {
  if (!REVIEW_VIEW_ID_PATTERN.test(view.id)) {
    throw new Error(`Invalid render view ${view.id}.`);
  }
  validateTexture(view.image, `Client framebuffer ${view.id}`);
  const scale = Math.min(
    1,
    CLIENT_PREVIEW_MAX_DIMENSION / view.width,
    CLIENT_PREVIEW_MAX_DIMENSION / view.height,
  );
  const width = Math.max(1, Math.floor(view.width * scale));
  const height = Math.max(1, Math.floor(view.height * scale));
  const data = Buffer.alloc(width * height * 4);
  drawNearest(data, width, view.image, 0, 0, width, height);
  const image: PixelImage = { width, height, data };
  const png = encodePng(image, { maxFileBytes: MAX_CLIENT_PREVIEW_BYTES });
  return {
    id: view.id,
    width,
    height,
    image,
    png,
    sha256: sha256(png),
  };
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

/** Renders an already compiled semantic item through its selected scene-review profile. */
export function renderCompiledItemAsset(
  compiled: CompiledItemAsset,
  options: RenderModelSpecOptions = {},
): RenderBundle {
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
    renderOnlyDefinedFaces: true,
    shade: element.shade,
  }));
  const displayTransforms: Record<string, RenderDisplayTransform> = {};
  for (const [context, transform] of Object.entries(resolveDisplayTransforms(normalizedSpec))) {
    displayTransforms[context] = transform;
  }
  const viewSize = options.viewSize ?? 96;
  if (!Number.isSafeInteger(viewSize) || viewSize < 32 || viewSize > MAX_VIEW_SIZE) {
    throw new Error(
      `Render view size must be an integer from 32 through ${String(MAX_VIEW_SIZE)}.`,
    );
  }
  const background = options.background ?? DEFAULT_BACKGROUND;
  validateColor(background, 'Render background');
  const plan = resolveReviewProfile(normalizedSpec, viewSize);
  const budget: RenderBudget = { remainingSamples: MAX_RASTER_SAMPLES };
  const views = plan.scenes.map((definition) => {
    abortIfNeeded(options.signal);
    const reference = referenceGeometry(definition, normalizedSpec);
    const scene: CuboidRenderScene = {
      id: normalizedSpec.id,
      targetKind: 'item',
      parts: [...parts, ...reference.parts],
      materials: { ...materials, ...reference.materials },
      displayTransforms,
    };
    return renderView(
      scene,
      validateScene(scene),
      reviewView(definition),
      background,
      budget,
      options.signal,
    );
  });
  const evaluation = evaluateReviewProfile(normalizedSpec, plan, views, displayTransforms);
  abortIfNeeded(options.signal);
  return {
    sceneId: normalizedSpec.id,
    renderer: REVIEW_PROFILE_RENDERER_VERSION,
    views,
    contactSheet: createContactSheet(views),
    reviewProfile: plan,
    evaluation,
  };
}

/** Renders a semantic item from the compiler's canonical geometry and resolved display data. */
export function renderModelSpec(
  spec: ModelSpec,
  options: RenderModelSpecOptions = {},
): RenderBundle {
  return renderCompiledItemAsset(compileItemAsset(spec), options);
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
