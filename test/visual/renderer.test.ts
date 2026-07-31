import { describe, expect, it } from 'vitest';

import { compileItemAsset } from '../../src/visual/compiler.js';
import { MAX_MODEL_PARTS, parseModelSpec } from '../../src/visual/model-spec.js';
import { decodePng, type PixelImage } from '../../src/visual/png.js';
import {
  CPU_RENDER_LIMITS,
  createBoundedClientPreview,
  renderCuboidDraft,
  renderModelSpec,
  solidTexture,
  type CuboidRenderScene,
} from '../../src/visual/renderer.js';
import { REVIEW_PROFILE_RENDERER_VERSION } from '../../src/visual/review-profile.js';

const STAFF: CuboidRenderScene = {
  id: 'arcana:firestaff',
  targetKind: 'item',
  materials: {
    wood: { texture: solidTexture(4, 4, [92, 54, 31, 255]) },
    crystal: { texture: solidTexture(4, 4, [255, 70, 20, 210]), emissive: true },
  },
  parts: [
    { id: 'handle', from: [7, 0, 7], to: [9, 13, 9], material: 'wood' },
    { id: 'crystal', from: [5, 12, 6], to: [10, 16, 10], material: 'crystal' },
  ],
};

function gradientTexture(width: number, height: number): PixelImage {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = (x * 17) % 256;
      data[offset + 1] = (y * 19) % 256;
      data[offset + 2] = ((x + y) * 23) % 256;
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
}

describe('deterministic CPU visual renderer', () => {
  it('shares the ModelSpec part ceiling', () => {
    expect(CPU_RENDER_LIMITS.maxParts).toBe(MAX_MODEL_PARTS);
    expect(MAX_MODEL_PARTS).toBe(512);
  });

  it('produces stable turntable/context PNGs and a bounded contact sheet', () => {
    const first = renderCuboidDraft(STAFF);
    const second = renderCuboidDraft(STAFF);

    expect(first.renderer).toBe('packwright-cpu-v1');
    expect(first.views).toHaveLength(15);
    expect(first.views.map((view) => view.sha256)).toEqual(second.views.map((view) => view.sha256));
    expect(first.contactSheet.sha256).toBe(second.contactSheet.sha256);
    expect(first.contactSheet.png.length).toBeLessThan(1024 * 1024);
    expect(decodePng(first.contactSheet.png)).toMatchObject({ width: 400, height: 400 });
    expect(first.views.find((view) => view.id === 'inventory_32')).toMatchObject({
      width: 32,
      height: 32,
    });
    expect(first.views.find((view) => view.id === 'turntable_front')?.sha256).not.toBe(
      first.views.find((view) => view.id === 'turntable_rear')?.sha256,
    );
  });

  it('creates deterministic MCP-safe previews without changing authoritative source evidence', () => {
    const image = gradientTexture(1280, 720);
    const source = {
      id: 'fp_right_steve',
      width: image.width,
      height: image.height,
      image,
      png: Buffer.from('authoritative-framebuffer-evidence'),
      sha256: 'f'.repeat(64),
    };
    const first = createBoundedClientPreview(source);
    const second = createBoundedClientPreview(source);

    expect(first).toMatchObject({ id: source.id, width: 352, height: 198 });
    expect(first.sha256).toBe(second.sha256);
    expect(first.png).toEqual(second.png);
    expect(first.png.length).toBeLessThan(600 * 1024);
    expect(first.sha256).not.toBe(source.sha256);
    expect(decodePng(first.png)).toMatchObject({ width: 352, height: 198 });
  });

  it('renders held-item profile views deterministically with visible reference geometry', () => {
    const spec = parseModelSpec({
      id: 'arcana:reference_fixture',
      targetKind: 'item',
      materials: {
        invisible: { color: '#00000000', transparent: true },
      },
      parts: [
        {
          id: 'invisible_item',
          shape: 'cuboid',
          from: [7, 4, 7],
          to: [9, 12, 9],
          material: 'invisible',
        },
      ],
      heldItem: {},
    });
    const background = [3, 5, 7, 255] as const;
    const first = renderModelSpec(spec, { viewSize: 64, background });
    const second = renderModelSpec(spec, { viewSize: 64, background });

    expect(first.renderer).toBe(REVIEW_PROFILE_RENDERER_VERSION);
    expect(first.reviewProfile).toMatchObject({
      profileId: 'held_item',
      requiredViewIds: [
        'fp_right_steve',
        'fp_right_alex',
        'fp_left_steve',
        'fp_left_alex',
        'fp_right_wide',
        'tp_rear_right_steve',
        'tp_rear_right_alex',
        'tp_front_right_steve',
        'tp_front_right_alex',
        'tp_rear_left_steve',
        'tp_rear_left_alex',
        'item_neutral',
      ],
    });
    expect(first.views.map((view) => view.id)).toEqual(first.reviewProfile?.requiredViewIds);
    expect(first.views.map((view) => view.sha256)).toEqual(second.views.map((view) => view.sha256));
    expect(first.contactSheet.sha256).toBe(second.contactSheet.sha256);

    const pixelCountOutsideBackground = (image: PixelImage | undefined): number => {
      if (image === undefined) return 0;
      let count = 0;
      for (let offset = 0; offset < image.data.length; offset += 4) {
        if (
          image.data[offset] !== background[0] ||
          image.data[offset + 1] !== background[1] ||
          image.data[offset + 2] !== background[2] ||
          image.data[offset + 3] !== background[3]
        ) {
          count += 1;
        }
      }
      return count;
    };
    const steve = first.views.find((view) => view.id === 'fp_right_steve');
    const alex = first.views.find((view) => view.id === 'fp_right_alex');
    const neutral = first.views.find((view) => view.id === 'item_neutral');
    expect(pixelCountOutsideBackground(steve?.image)).toBeGreaterThan(0);
    expect(pixelCountOutsideBackground(alex?.image)).toBeGreaterThan(0);
    expect(pixelCountOutsideBackground(neutral?.image)).toBe(0);
    expect(steve?.sha256).not.toBe(alex?.sha256);
  });

  it('renders exactly-flat planes through the semantic held-item adapter', () => {
    const spec = parseModelSpec({
      id: 'arcana:flame_card',
      targetKind: 'item',
      template: 'flat',
      materials: { flame: { color: '#ff5500', emissive: true, transparent: false } },
      parts: [
        {
          id: 'card',
          shape: 'plane',
          from: [2, 1, 8],
          to: [14, 15, 8],
          material: 'flame',
          uvMode: 'box',
          shade: false,
        },
      ],
    });
    const result = renderModelSpec(spec);
    const neutral = result.views.find((view) => view.id === 'item_neutral');

    const hasOrangePixel = (data: Uint8Array): boolean => {
      for (let offset = 0; offset < data.length; offset += 4) {
        if (
          (data[offset] ?? 0) > 200 &&
          (data[offset + 1] ?? 0) > 40 &&
          (data[offset + 2] ?? 255) < 80
        ) {
          return true;
        }
      }
      return false;
    };

    expect(result.reviewProfile?.profileId).toBe('held_item');
    expect(hasOrangePixel(neutral?.image.data ?? Buffer.alloc(0))).toBe(true);
  });

  it('does not block a one-handed item on measurements from the undeclared hand', () => {
    const spec = parseModelSpec({
      id: 'arcana:right_only',
      targetKind: 'item',
      materials: { metal: { color: '#8899aa' } },
      parts: [
        { id: 'body', shape: 'cuboid', from: [6, 2, 6], to: [10, 14, 10], material: 'metal' },
      ],
      heldItem: { handedness: 'right' },
      display: {
        firstperson_lefthand: {
          rotation: [0, 90, -25],
          translation: [70, 3.2, 1.13],
          scale: [0.68, 0.68, 0.68],
        },
      },
    });
    const result = renderModelSpec(spec, { viewSize: 64 });
    const leftMeasurements = result.evaluation?.measurements.filter((measurement) =>
      measurement.view?.includes('left'),
    );

    expect(result.evaluation?.reviewReady).toBe(true);
    expect(leftMeasurements?.length).toBeGreaterThan(0);
    expect(leftMeasurements?.every((measurement) => measurement.status === 'skipped')).toBe(true);
  });

  it('measures a declared secondary grip against the independently calibrated offhand', () => {
    const spec = parseModelSpec({
      id: 'arcana:two_handed',
      targetKind: 'item',
      materials: { metal: { color: '#8899aa' } },
      parts: [
        { id: 'body', shape: 'cuboid', from: [6, 2, 6], to: [10, 14, 10], material: 'metal' },
      ],
      heldItem: { twoHanded: true, secondaryGrip: [8, 10.5, 11] },
    });
    const result = renderModelSpec(spec, { viewSize: 64 });

    expect(
      result.evaluation?.measurements.find(
        (measurement) => measurement.metric === 'secondary_grip_distance',
      ),
    ).toMatchObject({ view: 'two_handed', status: 'passed', value: 0 });
  });

  it('weights screen obstruction by texture alpha', () => {
    const base = {
      id: 'arcana:alpha_coverage',
      targetKind: 'item' as const,
      parts: [
        {
          id: 'screen',
          shape: 'plane' as const,
          from: [0, 0, 8] as const,
          to: [16, 16, 8] as const,
          material: 'screen',
        },
      ],
      heldItem: { handedness: 'right' as const },
    };
    const transparent = renderModelSpec(
      parseModelSpec({ ...base, materials: { screen: { color: '#ffffff01', transparent: true } } }),
      { viewSize: 64 },
    );
    const opaque = renderModelSpec(
      parseModelSpec({ ...base, materials: { screen: { color: '#ffffffff' } } }),
      { viewSize: 64 },
    );
    const coverage = (result: ReturnType<typeof renderModelSpec>): number =>
      result.evaluation?.measurements.find(
        (measurement) =>
          measurement.metric === 'screen_obscuration' && measurement.view === 'fp_right_steve',
      )?.value ?? 0;

    expect(coverage(transparent)).toBeLessThan(coverage(opaque) / 100);
  });

  it('does not synthesize omitted faces for compiled manual geometry', () => {
    const base = {
      id: 'arcana:partial_faces',
      targetKind: 'item' as const,
      materials: { metal: { color: '#8899aa' } },
      heldItem: { handedness: 'right' as const },
    };
    const complete = parseModelSpec({
      ...base,
      parts: [
        { id: 'body', shape: 'cuboid', from: [4, 4, 4], to: [12, 12, 12], material: 'metal' },
      ],
    });
    const northOnly = parseModelSpec({
      ...base,
      parts: [
        {
          id: 'body',
          shape: 'cuboid',
          from: [4, 4, 4],
          to: [12, 12, 12],
          material: 'metal',
          uvMode: 'manual',
          faces: { north: { uv: [0, 0, 16, 16] } },
        },
      ],
    });

    expect(renderModelSpec(northOnly, { viewSize: 64 }).contactSheet.sha256).not.toBe(
      renderModelSpec(complete, { viewSize: 64 }).contactSheet.sha256,
    );
  });

  it('renders a default display preset identically to its explicit compiled transforms', () => {
    const defaultPreset = parseModelSpec({
      id: 'arcana:preset_parity',
      targetKind: 'item',
      materials: { gem: { color: '#ff5500' } },
      parts: [
        {
          id: 'offset_gem',
          shape: 'cuboid',
          from: [2, 1, 4],
          to: [7, 14, 10],
          material: 'gem',
        },
      ],
    });
    const compiled = compileItemAsset(defaultPreset);
    const model = JSON.parse(
      compiled.files.find((file) => file.role === 'model')?.content ?? '{}',
    ) as { display?: unknown };
    if (model.display === undefined) throw new Error('Compiled model omitted display transforms.');
    const explicit = parseModelSpec({ ...defaultPreset, display: model.display });

    const fromPreset = renderModelSpec(defaultPreset, { viewSize: 32 });
    const fromCompiledTransforms = renderModelSpec(explicit, { viewSize: 32 });

    expect(fromPreset.views.map((view) => view.sha256)).toEqual(
      fromCompiledTransforms.views.map((view) => view.sha256),
    );
    expect(fromPreset.contactSheet.sha256).toBe(fromCompiledTransforms.contactSheet.sha256);
  });

  it('renders box UVs from the compiler deterministic atlas assignments', () => {
    const automatic = parseModelSpec({
      id: 'arcana:auto_uv_parity',
      targetKind: 'item',
      textureSize: [16, 16],
      materials: { atlas: {} },
      parts: [
        {
          id: 'asymmetric_box',
          shape: 'cuboid',
          from: [2, 1, 3],
          to: [13, 15, 11],
          material: 'atlas',
          uvMode: 'box',
        },
      ],
    });
    const compiled = compileItemAsset(automatic);
    const assignments = compiled.uvLayout.filter(
      (assignment) => assignment.partId === 'asymmetric_box',
    );
    expect(assignments).toHaveLength(6);
    const automaticPart = automatic.parts[0];
    if (automaticPart === undefined) throw new Error('Automatic UV fixture omitted its part.');
    const explicit = parseModelSpec({
      ...automatic,
      parts: [
        {
          ...automaticPart,
          uvMode: 'manual',
          faces: Object.fromEntries(
            assignments.map((assignment) => [assignment.face, { uv: assignment.uv, rotation: 0 }]),
          ),
        },
      ],
    });
    const textures = { atlas: gradientTexture(16, 16) };

    const fromBoxUv = renderModelSpec(automatic, { textures, viewSize: 32 });
    const fromExplicitUv = renderModelSpec(explicit, { textures, viewSize: 32 });

    expect(fromBoxUv.views.map((view) => view.sha256)).toEqual(
      fromExplicitUv.views.map((view) => view.sha256),
    );
    expect(fromBoxUv.contactSheet.sha256).toBe(fromExplicitUv.contactSheet.sha256);
  });

  it('applies the compiler constant tint to imported texture pixels', () => {
    const base = {
      id: 'arcana:tint_parity',
      targetKind: 'item' as const,
      parts: [
        {
          id: 'gem',
          shape: 'cuboid' as const,
          from: [4, 2, 4] as const,
          to: [12, 14, 12] as const,
          material: 'gem',
        },
      ],
    };
    const tinted = parseModelSpec({
      ...base,
      materials: { gem: { color: '#ff0000', tintIndex: 0 } },
    });
    const solid = parseModelSpec({
      ...base,
      materials: { gem: { color: '#ff0000' } },
    });

    const tintedRender = renderModelSpec(tinted, {
      textures: { gem: solidTexture(16, 16, [255, 255, 255, 255]) },
      viewSize: 32,
    });
    const solidRender = renderModelSpec(solid, { viewSize: 32 });

    expect(tintedRender.views.map((view) => view.sha256)).toEqual(
      solidRender.views.map((view) => view.sha256),
    );
  });

  it('treats semantic parents as review metadata just like compiled item elements', () => {
    const rotor = {
      id: 'rotor',
      shape: 'cuboid',
      from: [6, 2, 6],
      to: [10, 14, 10],
      material: 'metal',
      rotation: { axis: 'y', angle: 45, pivot: [8, 8, 8] },
    } as const;
    const child = {
      id: 'child',
      shape: 'cuboid',
      from: [10, 9, 6],
      to: [15, 13, 10],
      material: 'gem',
    } as const;
    const input = {
      id: 'arcana:semantic_parent_parity',
      targetKind: 'item',
      materials: { metal: { color: '#777777' }, gem: { color: '#ff3300' } },
    } as const;
    const parented = parseModelSpec({
      ...input,
      parts: [rotor, { ...child, parent: 'rotor' }],
    });
    const independent = parseModelSpec({ ...input, parts: [rotor, child] });

    expect(compileItemAsset(parented).files.find((file) => file.role === 'model')?.sha256).toBe(
      compileItemAsset(independent).files.find((file) => file.role === 'model')?.sha256,
    );
    const fromParented = renderModelSpec(parented, { viewSize: 32 });
    const fromIndependent = renderModelSpec(independent, { viewSize: 32 });
    expect(fromParented.views.map((view) => view.sha256)).toEqual(
      fromIndependent.views.map((view) => view.sha256),
    );
  });

  it('applies the element rescale emitted by the compiler', () => {
    const input = {
      id: 'arcana:rescale_parity',
      targetKind: 'item',
      materials: { blade: { color: '#55aaff' } },
      parts: [
        {
          id: 'blade',
          shape: 'cuboid',
          from: [2, 2, 6],
          to: [9, 15, 10],
          material: 'blade',
          rotation: { axis: 'y', angle: 45, pivot: [8, 8, 8], rescale: false },
        },
      ],
    } as const;
    const unscaled = parseModelSpec(input);
    const rescaled = parseModelSpec({
      ...input,
      parts: [
        {
          ...input.parts[0],
          rotation: { ...input.parts[0].rotation, rescale: true },
        },
      ],
    });
    const compiled = compileItemAsset(rescaled);
    const model = JSON.parse(
      compiled.files.find((file) => file.role === 'model')?.content ?? '{}',
    ) as { elements?: { rotation?: { rescale?: boolean } }[] };
    expect(model.elements?.[0]?.rotation?.rescale).toBe(true);

    expect(
      renderModelSpec(rescaled, { viewSize: 32 }).views.map((view) => view.sha256),
    ).not.toEqual(renderModelSpec(unscaled, { viewSize: 32 }).views.map((view) => view.sha256));
  });

  it('can omit context views while retaining the complete turntable', () => {
    const result = renderCuboidDraft(STAFF, { includeContexts: false });

    expect(result.views.map((view) => view.id)).toEqual([
      'turntable_front',
      'turntable_front_right',
      'turntable_right',
      'turntable_rear_right',
      'turntable_rear',
      'turntable_rear_left',
      'turntable_left',
      'turntable_front_left',
    ]);
    expect(result.contactSheet.placements).toHaveLength(8);
    expect(result.contactSheet).toMatchObject({ width: 400, height: 200 });
  });

  it('rejects hierarchy cycles and invalid plane dimensions', () => {
    expect(() =>
      renderCuboidDraft({
        id: 'cycle',
        targetKind: 'item',
        parts: [
          { id: 'a', from: [0, 0, 0], to: [1, 1, 1], material: 'a', parent: 'b' },
          { id: 'b', from: [1, 1, 1], to: [2, 2, 2], material: 'b', parent: 'a' },
        ],
      }),
    ).toThrow(/cycle/u);
    expect(() =>
      renderCuboidDraft({
        id: 'bad-plane',
        targetKind: 'item',
        parts: [{ id: 'flat', shape: 'plane', from: [1, 1, 1], to: [1, 1, 2], material: 'x' }],
      }),
    ).toThrow(/exactly one axis/u);
    expect(() => solidTexture(100_000, 100_000, [0, 0, 0, 255])).toThrow(/limits/u);
  });

  it('uses opaque z-buffering before blending transparent surfaces back-to-front', () => {
    const rendered = renderCuboidDraft({
      id: 'layers',
      targetKind: 'item',
      materials: {
        back: { color: [0, 0, 255, 255], emissive: true },
        front: { color: [255, 0, 0, 128], emissive: true },
      },
      parts: [
        { id: 'back', from: [2, 2, 2], to: [14, 14, 6], material: 'back', shade: false },
        {
          id: 'front',
          shape: 'plane',
          from: [2, 2, 10],
          to: [14, 14, 10],
          material: 'front',
          shade: false,
        },
      ],
    });
    const front = rendered.views.find((view) => view.id === 'fixed');
    const offset =
      ((front?.height ?? 0) / 2) * (front?.width ?? 0) * 4 + ((front?.width ?? 0) / 2) * 4;

    expect(front?.image.data[offset]).toBeGreaterThan(100);
    expect(front?.image.data[offset + 2]).toBeGreaterThan(80);
  });
});
