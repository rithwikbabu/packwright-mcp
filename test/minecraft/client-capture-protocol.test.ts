import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { sha256Buffer } from '../../src/core/hash.js';
import {
  CLIENT_CAPTURE_DATAPACK_PROVENANCE_PATH,
  CLIENT_CAPTURE_PACK_ACTIVATION,
  CLIENT_CAPTURE_RESOURCEPACK_ID,
  CLIENT_CAPTURE_RESOURCEPACK_PATH,
  canonicalClientCapturePlanBytes,
  clientCaptureIdentityForPlan,
  clientCaptureViewAuthority,
  ClientCaptureRepresentationSchema,
  computeClientCaptureAppliedFixtureSha256,
  computeClientCaptureObservedFixtureSha256,
  computeClientCapturePlanSha256,
  computeClientCaptureRepresentationSha256,
  computeClientCaptureSceneSha256,
  computeClientCaptureStudioScaleReferenceSha256,
  computeClientCaptureStudioSha256,
  createClientCapturePlan,
  expectedClientCaptureObservedFixture,
  parseClientCapturePlan,
  parseClientCaptureReport,
  parseLegacyClientCapturePlanMetadata,
  verifyClientCaptureComplete,
  verifyClientCaptureOutput,
  type ClientCaptureCompleteReport,
  type ClientCapturePlan,
  type ClientCaptureRepresentation,
  type ClientCaptureScene,
  type ClientCaptureStudio,
} from '../../src/minecraft/client-capture-protocol.js';
import { encodePng } from '../../src/visual/png.js';
import { canonicalJsonBytes } from '../../src/visual/run-store.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const HASH_E = 'e'.repeat(64);
const HASH_F = 'f'.repeat(64);
const SHA1 = '1'.repeat(40);
const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((directory) => rm(directory, { recursive: true })));
});

const representation: ClientCaptureRepresentation = {
  targetKind: 'held_item',
  strategy: 'item_stack',
  capability: 'native',
  states: {
    default: {
      itemStack: {
        itemId: 'minecraft:stick',
        count: 1,
        components: { 'minecraft:item_model': '"arcana:firestaff"' },
      },
    },
  },
};
const representationSha256 = computeClientCaptureRepresentationSha256(representation);

const blockDisplayRepresentation = {
  targetKind: 'block',
  strategy: 'block_display',
  capability: 'simulated',
  states: {
    default: {
      blockDisplay: {
        id: 'block',
        kind: 'block_display',
        position: [0.5, 80, 5.5],
        yaw: 0,
        pitch: 0,
        transform: {
          translation: [0, 0, 0],
          leftRotation: [0, 0, 0],
          scale: [1, 1, 1],
          rightRotation: [0, 0, 0],
        },
        billboard: 'fixed',
        brightness: { block: 15, sky: 15 },
        shadow: { radius: 0.5, strength: 1 },
        interpolation: { duration: 0, startDelta: 0 },
        blockState: { id: 'minecraft:stone', properties: {} },
      },
    },
  },
  review: {
    transparency: false,
    biomeTintBiomes: [],
    animatedTextureTicks: [],
  },
} satisfies ClientCaptureRepresentation;

const studio: ClientCaptureStudio = {
  preset: 'void_matte',
  rendererBackend: 'opengl',
  renderDistance: 8,
  simulationDistance: 5,
  graphicsMode: 'custom',
  clouds: 'off',
  particles: 'minimal',
  entityShadows: true,
  viewBobbing: false,
  debugUi: false,
  floorBlock: { id: 'minecraft:smooth_stone', properties: {} },
  backdropBlock: { id: 'minecraft:light_gray_concrete', properties: {} },
  scaleReference: {
    kind: 'ordinary_block_floor_ruler',
    origin: { x: -2, y: 79, z: 7 },
    lengthBlocks: 2,
    firstBlock: { id: 'minecraft:black_concrete', properties: {} },
    secondBlock: { id: 'minecraft:white_concrete', properties: {} },
  },
};

function scene(
  baseSceneId: string,
  viewKind: ClientCaptureScene['viewKind'] = 'minecraft_vanilla',
): ClientCaptureScene {
  const firstPerson =
    viewKind === 'first_person_vanilla' || viewKind === 'first_person_scale_reference';
  const id = viewKind === 'minecraft_vanilla' ? baseSceneId : `${viewKind}--${baseSceneId}`;
  return {
    id,
    baseSceneId,
    targetKind: 'held_item',
    representationSha256,
    viewKind,
    requiredForAuthority: viewKind !== 'first_person_scale_reference',
    camera: firstPerson ? 'first_person' : 'neutral',
    context: firstPerson ? 'world' : 'inventory',
    hand: 'right',
    playerModel: 'steve',
    fov: 70,
    resolution: { width: 64, height: 64 },
    guiScale: 2,
    animationState: 'idle',
    frame: 0,
    cameraPoseSemantics: 'player_feet_anchor',
    cameraPose: { x: 0.5, y: 82.25, z: 0.5, yaw: 0, pitch: 14 },
    expectedRenderCameraPose: {
      x: 0.5,
      y: firstPerson ? 83.87 : 82.25,
      z: 0.5,
      yaw: 0,
      pitch: 14,
    },
    environment: {
      biome: 'minecraft:plains',
      time: 6000,
      weather: 'clear',
      lightProfile: 'day',
      skyLight: 15,
      blockLight: 0,
      lightSource: { level: 0, offset: { x: 0, y: 5, z: -2 } },
    },
    settlingTicks: 0,
    fixture: { kind: 'item_stack', stateId: 'default' },
    measurementIntents:
      viewKind === 'first_person_scale_reference'
        ? []
        : [
            {
              id: `m_${baseSceneId}`,
              metric: 'frame_retention',
              authority: 'client_pixels',
              unit: 'percent',
              requiredForReadiness: false,
            },
          ],
    comparisonSceneIds: [],
    ...(viewKind === 'first_person_scale_reference'
      ? {
          presentation: { referenceArm: true as const, referenceArmPurpose: 'scale_only' as const },
        }
      : {}),
  };
}

function planInput(
  executionId = 'capture-001',
  gameDirectory = '/private/tmp/packwright-game-001',
  outputDirectory = '/private/tmp/packwright-game-001/packwright-output',
  scaleReference = false,
) {
  return {
    schemaVersion: 3 as const,
    kind: 'packwright.client-capture-plan' as const,
    minecraftVersion: '26.2' as const,
    provenance: {
      projectId: 'firestaff',
      runId: HASH_A,
      revisionId: HASH_B,
      specSha256: HASH_C,
      compiledArtifactId: HASH_D,
      proposalArtifactId: HASH_E,
      projectManifestSha256: HASH_F,
      datapackContentSha256: '0'.repeat(64),
      resourcepackContentSha256: '2'.repeat(64),
      packActivation: CLIENT_CAPTURE_PACK_ACTIVATION,
      runtimeManifestSha256: '5'.repeat(64),
      representation,
      representationSha256,
      client: { jarSha1: SHA1, jarSha256: '3'.repeat(64) },
      captureMod: { id: 'packwright_capture', version: '0.5.0', sha256: '4'.repeat(64) },
    },
    studio,
    scenes: [
      scene('inventory'),
      ...(scaleReference ? [scene('fp_right_steve', 'first_person_scale_reference')] : []),
      scene('fp_right_steve', 'first_person_vanilla'),
    ],
    execution: { executionId, gameDirectory, outputDirectory },
  };
}

function blockDisplayPlan(): ClientCapturePlan {
  const exactRepresentation = ClientCaptureRepresentationSchema.parse(blockDisplayRepresentation);
  const exactHash = computeClientCaptureRepresentationSha256(exactRepresentation);
  const blockScene: ClientCaptureScene = {
    ...scene('block_display'),
    targetKind: 'block',
    representationSha256: exactHash,
    context: 'world',
    cameraPoseSemantics: 'player_feet_anchor',
    cameraPose: { x: 0.5, y: 82.25, z: 0.5, yaw: 0, pitch: 14 },
    expectedRenderCameraPose: { x: 0.5, y: 82.25, z: 0.5, yaw: 0, pitch: 14 },
    settlingTicks: 40,
    fixture: {
      kind: 'block_display',
      stateId: 'default',
      layout: 'single',
      orientation: 'three_quarter',
      animationTick: 0,
      blockPosition: { x: 0, y: 80, z: 5 },
      backdrop: 'studio',
      overlapCopies: 1,
    },
    measurementIntents: [],
  };
  const input = planInput('display-001');
  return createClientCapturePlan({
    ...input,
    provenance: {
      ...input.provenance,
      representation: exactRepresentation,
      representationSha256: exactHash,
    },
    scenes: [blockScene],
  });
}

function headwearPlan(): ClientCapturePlan {
  const exactRepresentation = ClientCaptureRepresentationSchema.parse({
    targetKind: 'headwear',
    strategy: 'equippable_head',
    capability: 'replacement',
    states: {
      default: {
        itemStack: {
          itemId: 'minecraft:carved_pumpkin',
          count: 1,
          components: { 'minecraft:equippable': '{slot:"head"}' },
        },
      },
    },
    headwear: { renderMode: 'fallback_item' },
    review: {
      wideFov: false,
      armorStand: true,
      statePoses: { default: 'idle' },
      chestArmorItemStack: {
        itemId: 'minecraft:diamond_chestplate',
        count: 1,
        components: { 'minecraft:enchantment_glint_override': 'true' },
      },
    },
  });
  const exactHash = computeClientCaptureRepresentationSha256(exactRepresentation);
  const headScene = (
    id: string,
    playerModel: 'steve' | 'alex',
    chestArmor: boolean,
  ): ClientCaptureScene => ({
    ...scene(id),
    targetKind: 'headwear',
    representationSha256: exactHash,
    camera: 'third_person_front',
    context: 'world',
    playerModel,
    fixture: {
      kind: 'equippable_head',
      stateId: 'default',
      subject: 'player',
      framing: 'full_body',
      pose: 'idle',
      subjectYaw: 0,
      viewAngle: 'front',
      cameraDistance: 6,
      chestArmor,
    },
    measurementIntents: [],
    comparisonSceneIds: chestArmor ? [`head_${playerModel}_front_full`] : [],
  });
  const input = planInput(
    'headwear-001',
    '/private/tmp/packwright-headwear-001',
    '/private/tmp/packwright-headwear-001/output',
  );
  const armorStandScene = (
    id: 'head_stand_front' | 'head_stand_side',
    viewAngle: 'front' | 'side',
  ): ClientCaptureScene => ({
    ...scene(id),
    targetKind: 'headwear',
    representationSha256: exactHash,
    camera: 'neutral',
    context: 'world',
    cameraPose: { x: 0.5, y: 80, z: 5.5, yaw: 0, pitch: 0 },
    expectedRenderCameraPose:
      viewAngle === 'front'
        ? { x: 0.5, y: 80.95, z: 11.5, yaw: 180, pitch: 0 }
        : { x: -5.5, y: 80.95, z: 5.5, yaw: -90, pitch: 0 },
    fixture: {
      kind: 'equippable_head',
      stateId: 'default',
      subject: 'armor_stand',
      framing: 'full_body',
      pose: 'idle',
      subjectYaw: 0,
      viewAngle,
      cameraDistance: 6,
      chestArmor: false,
    },
    measurementIntents: [],
    comparisonSceneIds: [],
  });
  return createClientCapturePlan({
    ...input,
    provenance: {
      ...input.provenance,
      representation: exactRepresentation,
      representationSha256: exactHash,
    },
    scenes: [
      headScene('head_steve_front_full', 'steve', false),
      headScene('head_chest_steve', 'steve', true),
      headScene('head_alex_front_full', 'alex', false),
      headScene('head_chest_alex', 'alex', true),
      armorStandScene('head_stand_front', 'front'),
      armorStandScene('head_stand_side', 'side'),
    ],
  });
}

function solidPng(width = 64, height = 64): Buffer {
  return encodePng({ width, height, data: new Uint8Array(width * height * 4).fill(0x7f) });
}

function fixtureEvidenceFor(
  plan: ClientCapturePlan,
  plannedScene: ClientCaptureScene,
): ClientCaptureCompleteReport['views'][number]['fixtureEvidence'] {
  const state = plan.provenance.representation.states[plannedScene.fixture.stateId];
  if (state === undefined) throw new Error('Missing planned representation state.');
  if (plannedScene.fixture.kind === 'measurement_control') {
    return {
      strategy: 'measurement_control',
      stateId: plannedScene.fixture.stateId,
      subjectOmitted: true,
    };
  }
  switch (plan.provenance.representation.strategy) {
    case 'item_stack':
      if (!('itemStack' in state)) throw new Error('Missing planned item stack.');
      return {
        strategy: 'item_stack',
        stateId: plannedScene.fixture.stateId,
        equippedItemId: state.itemStack.itemId,
        ...(plannedScene.context === 'world' ? { equipReady: true } : {}),
      };
    case 'block_display':
      if (!('blockDisplay' in state)) throw new Error('Missing planned block display.');
      return {
        strategy: 'block_display',
        stateId: plannedScene.fixture.stateId,
        placedBlockState: state.blockDisplay.blockState,
        displayNodeCount: 1,
      };
    case 'equippable_head':
      if (!('itemStack' in state) || plannedScene.fixture.kind !== 'equippable_head') {
        throw new Error('Missing planned headwear state.');
      }
      return {
        strategy: 'equippable_head',
        stateId: plannedScene.fixture.stateId,
        ...(plannedScene.fixture.subject === 'bare_control'
          ? {}
          : { equippedItemId: state.itemStack.itemId, equipReady: true as const }),
        ...(plannedScene.fixture.chestArmor
          ? {
              chestArmorItemId: plan.provenance.representation.review.chestArmorItemStack?.itemId,
              chestArmorReady: true as const,
            }
          : {}),
        headwearSubject: plannedScene.fixture.subject,
        headwearRenderMode: plan.provenance.representation.headwear.renderMode,
      };
    case 'native_entity':
    case 'native_placeable_entity':
      if (!('entity' in state)) throw new Error('Missing planned native entity state.');
      return {
        strategy: plan.provenance.representation.strategy,
        stateId: plannedScene.fixture.stateId,
        spawnedEntityType: state.entity.entityType,
        ...(state.entity.variant === undefined
          ? {}
          : { spawnedEntityVariant: state.entity.variant }),
        spawnedEntityBaby: state.entity.baby,
        spawnedEntityEquipment: state.entity.equipment,
        ...(plannedScene.fixture.kind === 'native_entity' && plannedScene.fixture.showPlayerScale
          ? { scaleReference: 'minecraft:mannequin' as const }
          : {}),
      };
    default:
      throw new Error('The focused protocol fixture does not implement this strategy.');
  }
}

function completeFixture(plan: ClientCapturePlan) {
  const pngs = new Map<string, Buffer>();
  const views = plan.scenes.map((plannedScene) => {
    const png = solidPng(plannedScene.resolution.width, plannedScene.resolution.height);
    const artifactPath = `views/${plannedScene.id}.png`;
    pngs.set(artifactPath, png);
    const observedFixture = expectedClientCaptureObservedFixture(
      plan.provenance.representation,
      plannedScene,
    );
    return {
      sceneId: plannedScene.id,
      sceneSha256: computeClientCaptureSceneSha256(plannedScene),
      scene: plannedScene,
      path: artifactPath,
      pngSha256: sha256Buffer(png),
      bytes: png.length,
      width: plannedScene.resolution.width,
      height: plannedScene.resolution.height,
      representationSha256: plan.provenance.representationSha256,
      studioSha256: computeClientCaptureStudioSha256(plan.studio),
      actualScaleReference: plan.studio.scaleReference,
      actualScaleReferenceSha256: computeClientCaptureStudioScaleReferenceSha256(
        plan.studio.scaleReference,
      ),
      fixtureSha256: sha256Buffer(canonicalJsonBytes(plannedScene.fixture)),
      appliedFixtureSha256: computeClientCaptureAppliedFixtureSha256(
        plan.provenance.representation,
        plannedScene,
      ),
      observedFixture,
      observedFixtureSha256: computeClientCaptureObservedFixtureSha256(observedFixture),
      actualSettledTicks: plannedScene.settlingTicks,
      renderedSettleFrames: 3,
      actualAnimationTick:
        'animationTick' in plannedScene.fixture
          ? plannedScene.fixture.animationTick
          : plannedScene.frame,
      actualCameraPose: plannedScene.expectedRenderCameraPose,
      actualCameraMode:
        plannedScene.camera === 'neutral' ? ('first_person' as const) : plannedScene.camera,
      actualContext: plannedScene.context,
      actualFov: plannedScene.fov,
      actualGuiScale: plannedScene.guiScale,
      actualHand: plannedScene.hand,
      actualPlayerModel: plannedScene.playerModel,
      actualEnvironment: plannedScene.environment,
      resourceReloadReady: true as const,
      modelBakeReady: true as const,
      fixtureEvidence: fixtureEvidenceFor(plan, plannedScene),
    };
  });
  const log = Buffer.from(
    '[Render thread/INFO]: Reloading ResourceManager\n[Render thread/INFO]: Model bake complete\n',
  );
  const measurements = plan.scenes.flatMap((plannedScene) =>
    plannedScene.measurementIntents.map((intent) => ({
      id: intent.id,
      metric: intent.metric,
      authority: 'client_pixels' as const,
      requiredForReadiness: intent.requiredForReadiness,
      sceneIds: [plannedScene.id, ...plannedScene.comparisonSceneIds].sort(),
      status: 'skipped' as const,
      unit: intent.unit,
      message: 'No calibrated foreground mask is available; inspect the hashed framebuffer.',
      sourcePngSha256s: [],
    })),
  );
  const report: ClientCaptureCompleteReport = {
    schemaVersion: 3,
    kind: 'packwright.client-capture-report',
    status: 'complete',
    executionId: plan.execution.executionId,
    planSha256: plan.planSha256,
    identity: clientCaptureIdentityForPlan(plan),
    packActivation: {
      datapack: {
        mode: CLIENT_CAPTURE_PACK_ACTIVATION.datapack,
        archivePath: CLIENT_CAPTURE_DATAPACK_PROVENANCE_PATH,
        archiveSha256: plan.provenance.datapackContentSha256,
        selected: false,
        selectedPackIds: ['vanilla'],
      },
      resourcepack: {
        mode: CLIENT_CAPTURE_PACK_ACTIVATION.resourcepack,
        archivePath: CLIENT_CAPTURE_RESOURCEPACK_PATH,
        archiveSha256: plan.provenance.resourcepackContentSha256,
        selected: true,
        selectedPackIds: [CLIENT_CAPTURE_RESOURCEPACK_ID],
      },
    },
    runtime: {
      rendererBackend: 'opengl',
      operatingSystem: 'macOS test',
      javaVersion: '25.0.1',
      gpuVendor: 'Test GPU Vendor',
      gpuRenderer: 'Test GPU',
      driverVersion: 'Test Driver 1.0',
      studioSha256: computeClientCaptureStudioSha256(plan.studio),
      settings: {
        preferredGraphicsBackend: 'opengl',
        graphicsMode: 'custom',
        clouds: 'off',
        particles: 'minimal',
        entityShadows: true,
        viewBobbing: false,
        renderDistance: 8,
        simulationDistance: 5,
        debugUi: false,
      },
      settingsSha256: sha256Buffer(
        canonicalJsonBytes({
          preferredGraphicsBackend: 'opengl',
          graphicsMode: 'custom',
          clouds: 'off',
          particles: 'minimal',
          entityShadows: true,
          viewBobbing: false,
          renderDistance: 8,
          simulationDistance: 5,
          debugUi: false,
        }),
      ),
      resourceReloadReadyTick: 4,
      modelBakeReadyTick: 4,
    },
    views,
    measurements,
    log: {
      path: 'logs/client.log',
      sha256: sha256Buffer(log),
      bytes: log.length,
      resourceReloadSucceeded: true,
      modelBakeSucceeded: true,
      excerpts: ['Reloading ResourceManager', 'Model bake complete'],
    },
  };
  return { report, pngs, log };
}

describe('client capture protocol v3', () => {
  it('round-trips canonical plans and hash-binds exact representation and studio settings', () => {
    const first = createClientCapturePlan(planInput());
    const second = createClientCapturePlan(
      planInput('capture-999', '/private/tmp/other-game', '/private/tmp/other-game/output'),
    );

    expect(first.schemaVersion).toBe(3);
    expect(first.planSha256).toBe(second.planSha256);
    expect(first.provenance.representationSha256).toBe(representationSha256);
    expect(clientCaptureIdentityForPlan(first)).toMatchObject({
      representationSha256,
      studioSha256: computeClientCaptureStudioSha256(studio),
    });
    expect(canonicalClientCapturePlanBytes(first)).toEqual(canonicalJsonBytes(first));
    expect(parseClientCapturePlan(JSON.parse(JSON.stringify(first)))).toEqual(first);

    const changedScaleReference = structuredClone(first) as unknown as {
      studio: { scaleReference: { firstBlock: { id: string } } };
    };
    changedScaleReference.studio.scaleReference.firstBlock.id = 'minecraft:red_concrete';
    expect(() => parseClientCapturePlan(changedScaleReference)).toThrow();

    const changedRepresentation = structuredClone(representation);
    const changedDefault = changedRepresentation.states.default;
    if (changedDefault === undefined) throw new Error('Expected a default item state.');
    changedDefault.itemStack.count = 2;
    expect(() =>
      createClientCapturePlan({
        ...planInput(),
        provenance: { ...planInput().provenance, representation: changedRepresentation },
      }),
    ).toThrow(/representation hash/u);
  });

  it('binds provenance-only datapack staging and exact pack activation evidence', () => {
    const plan = createClientCapturePlan(planInput());
    const fixture = completeFixture(plan);
    expect(() => parseClientCaptureReport(fixture.report, plan)).not.toThrow();

    expect(() =>
      createClientCapturePlan({
        ...planInput(),
        provenance: {
          ...planInput().provenance,
          packActivation: { datapack: 'active', resourcepack: 'active' },
        },
      } as never),
    ).toThrow();

    const selectedDatapack = structuredClone(fixture.report);
    selectedDatapack.packActivation.datapack.selectedPackIds = [CLIENT_CAPTURE_RESOURCEPACK_ID];
    expect(() => parseClientCaptureReport(selectedDatapack, plan)).toThrow(/must not be selected/u);

    const staleArchive = structuredClone(fixture.report);
    staleArchive.packActivation.datapack.archiveSha256 = '9'.repeat(64);
    expect(() => parseClientCaptureReport(staleArchive, plan)).toThrow(/pack-activation evidence/u);
  });

  it('binds exact chest-armor compatibility and rejects altered client-world readback', () => {
    const plan = headwearPlan();
    const fixture = completeFixture(plan);
    expect(() => parseClientCaptureReport(fixture.report, plan)).not.toThrow();

    const chestIndex = fixture.report.views.findIndex(
      (view) => view.sceneId === 'head_chest_steve',
    );
    const chest = fixture.report.views[chestIndex];
    if (chest === undefined) throw new Error('Missing chest-armor fixture view.');
    expect(chest.fixtureEvidence).toMatchObject({
      equippedItemId: 'minecraft:carved_pumpkin',
      chestArmorItemId: 'minecraft:diamond_chestplate',
      chestArmorReady: true,
    });
    expect(chest.observedFixture).toMatchObject({
      strategy: 'equippable_head',
      subject: 'player',
      chestArmorItemStack: { itemId: 'minecraft:diamond_chestplate', count: 1 },
    });

    const alteredEvidence = structuredClone(fixture.report);
    const evidenceView = alteredEvidence.views[chestIndex];
    if (evidenceView === undefined) throw new Error('Missing altered evidence view.');
    evidenceView.fixtureEvidence.chestArmorItemId = 'minecraft:iron_chestplate';
    expect(() => parseClientCaptureReport(alteredEvidence, plan)).toThrow(/chest-armor/u);

    const alteredObserved = structuredClone(fixture.report);
    const observedView = alteredObserved.views[chestIndex];
    if (observedView === undefined) throw new Error('Missing altered observed view.');
    if (observedView.observedFixture.strategy !== 'equippable_head') {
      throw new Error('Expected headwear observed fixture.');
    }
    observedView.observedFixture.chestArmorItemStack = {
      itemId: 'minecraft:iron_chestplate',
      count: 1,
      components: {},
    };
    observedView.observedFixtureSha256 = computeClientCaptureObservedFixtureSha256(
      observedView.observedFixture,
    );
    expect(() => parseClientCaptureReport(alteredObserved, plan)).toThrow(
      /client-world fixture readback/u,
    );
  });

  it('keeps every augmented view supplemental and requires exact authoritative pairs', () => {
    const plan = createClientCapturePlan(
      planInput('capture-paired', '/private/tmp/pair', '/private/tmp/pair/output', true),
    );
    const vanilla = plan.scenes.find((entry) => entry.viewKind === 'first_person_vanilla');
    const scale = plan.scenes.find((entry) => entry.viewKind === 'first_person_scale_reference');

    expect(vanilla).toMatchObject({ requiredForAuthority: true });
    expect(scale).toMatchObject({
      requiredForAuthority: false,
      presentation: { referenceArm: true, referenceArmPurpose: 'scale_only' },
    });
    expect(scale === undefined ? undefined : clientCaptureViewAuthority(scale)).toBe(
      'augmented_qa_reference',
    );
    expect(() =>
      createClientCapturePlan({
        ...planInput(),
        scenes: [
          { ...scene('fp_right_steve', 'first_person_scale_reference'), fov: 100 },
          scene('fp_right_steve', 'first_person_vanilla'),
        ],
      }),
    ).toThrow(/does not match/u);
  });

  it('keeps empty-subject measurement controls supplemental and exactly paired', () => {
    const basePlan = blockDisplayPlan();
    const base = basePlan.scenes[0];
    if (base === undefined) throw new Error('Missing block-display base scene.');
    const controlId = `measurement_control--${base.baseSceneId}`;
    const boundBase: ClientCaptureScene = {
      ...base,
      comparisonSceneIds: [controlId],
      measurementIntents: [
        {
          id: 'm_block_foreground',
          metric: 'pairwise_pixel_delta',
          authority: 'client_pixels',
          unit: 'percent',
          requiredForReadiness: false,
          sourceSceneIds: [base.id, controlId],
        },
      ],
    };
    const control: ClientCaptureScene = {
      ...boundBase,
      id: controlId,
      viewKind: 'measurement_control',
      requiredForAuthority: false,
      settlingTicks: 0,
      fixture: {
        kind: 'measurement_control',
        targetKind: 'block',
        stateId: base.fixture.stateId,
        control: 'empty_subject',
      },
      measurementIntents: [],
      comparisonSceneIds: [boundBase.id],
    };
    const controlInput = {
      schemaVersion: 3 as const,
      kind: 'packwright.client-capture-plan' as const,
      minecraftVersion: '26.2' as const,
      provenance: basePlan.provenance,
      studio: basePlan.studio,
      scenes: [boundBase, control],
      execution: {
        executionId: 'measurement-control-001',
        gameDirectory: '/private/tmp/packwright-control-001',
        outputDirectory: '/private/tmp/packwright-control-001/output',
      },
    };
    const explicitIntent = boundBase.measurementIntents[0];
    if (explicitIntent === undefined) throw new Error('Missing explicit source-bound measurement.');
    const plan = createClientCapturePlan(controlInput);
    const parsedControl = plan.scenes.find((entry) => entry.viewKind === 'measurement_control');
    expect(parsedControl).toBeDefined();
    expect(
      parsedControl === undefined ? undefined : clientCaptureViewAuthority(parsedControl),
    ).toBe('augmented_qa_reference');
    expect(
      parsedControl === undefined
        ? undefined
        : expectedClientCaptureObservedFixture(plan.provenance.representation, parsedControl),
    ).toMatchObject({
      strategy: 'measurement_control',
      targetKind: 'block',
      baseSceneId: base.baseSceneId,
      subjectOmitted: true,
    });
    expect(() =>
      createClientCapturePlan({
        ...controlInput,
        scenes: [boundBase, { ...control, requiredForAuthority: true }],
      }),
    ).toThrow();
    expect(() =>
      createClientCapturePlan({
        ...controlInput,
        scenes: [boundBase, { ...control, fov: control.fov + 1 }],
      }),
    ).toThrow(/empty-subject pair/u);
    expect(() =>
      createClientCapturePlan({
        ...controlInput,
        scenes: [
          {
            ...boundBase,
            measurementIntents: [{ ...explicitIntent, sourceSceneIds: [controlId] }],
          },
          control,
        ],
      }),
    ).toThrow(/include its owning scene/u);
    expect(() =>
      createClientCapturePlan({
        ...controlInput,
        scenes: [
          {
            ...boundBase,
            measurementIntents: [{ ...explicitIntent, sourceSceneIds: [controlId, base.id] }],
          },
          control,
        ],
      }),
    ).toThrow(/ASCII sorted/u);
    expect(() =>
      createClientCapturePlan({
        ...controlInput,
        scenes: [
          {
            ...boundBase,
            measurementIntents: [
              {
                ...explicitIntent,
                requiredForReadiness: true,
                threshold: { comparison: 'below', warning: 0.1, failure: 0 },
              },
            ],
          },
          control,
        ],
      }),
    ).toThrow(/authoritative required framebuffer sources/u);
    const missingCriticality = {
      ...explicitIntent,
    } as Record<string, unknown>;
    delete missingCriticality.requiredForReadiness;
    expect(() =>
      createClientCapturePlan({
        ...controlInput,
        scenes: [
          {
            ...boundBase,
            measurementIntents: [
              missingCriticality as unknown as (typeof boundBase.measurementIntents)[number],
            ],
          },
          control,
        ],
      }),
    ).toThrow();
  });

  it('rejects stale proposal bindings, undeclared states, missing deterministic settings, and unknown executable input', () => {
    const input = planInput();
    expect(() =>
      createClientCapturePlan({
        ...input,
        scenes: [{ ...scene('inventory'), representationSha256: '9'.repeat(64) }],
      }),
    ).toThrow(/representation hash/u);
    expect(() =>
      createClientCapturePlan({
        ...input,
        scenes: [
          { ...scene('inventory'), fixture: { kind: 'item_stack' as const, stateId: 'missing' } },
        ],
      }),
    ).toThrow(/undeclared representation state/u);
    expect(() =>
      parseClientCapturePlan({
        ...createClientCapturePlan(input),
        studio: { ...studio, debugUi: true },
      }),
    ).toThrow();
    expect(() =>
      parseClientCapturePlan({
        ...createClientCapturePlan(input),
        savePath: '/Users/me/saves/world',
      }),
    ).toThrow(/unrecognized/u);
  });

  it('rejects arbitrary commands, functions, mod paths, credentials, and alternate item states', () => {
    const forbidden = ['command', 'function', 'savePath', 'modPath', 'credential'];
    for (const field of forbidden) {
      expect(() =>
        computeClientCaptureRepresentationSha256({
          targetKind: 'placeable',
          strategy: 'display_rig',
          capability: 'simulated',
          states: {
            default: {
              displayRig: {
                nodes: [
                  {
                    id: 'body',
                    kind: 'block_display',
                    position: [0, 1, 0],
                    yaw: 0,
                    pitch: 0,
                    transform: {
                      translation: [0, 0, 0],
                      leftRotation: [0, 0, 0],
                      scale: [1, 1, 1],
                      rightRotation: [0, 0, 0],
                    },
                    billboard: 'fixed',
                    brightness: { block: 15, sky: 15 },
                    shadow: { radius: 0.5, strength: 1 },
                    interpolation: { duration: 0, startDelta: 0 },
                    blockState: { id: 'minecraft:stone', properties: {} },
                    [field]: 'forbidden',
                  },
                ],
              },
            },
          },
          review: {
            orientations: ['north'],
            attachments: ['floor'],
            placementStates: [{ orientation: 'north', attachment: 'floor', stateId: 'default' }],
          },
        }),
      ).toThrow();
    }
    expect(() =>
      computeClientCaptureRepresentationSha256({
        targetKind: 'held_item',
        strategy: 'item_stack',
        capability: 'native',
        states: {
          z_state: { itemStack: { itemId: 'minecraft:stick', count: 1, components: {} } },
          a_state: { itemStack: { itemId: 'minecraft:stick', count: 1, components: {} } },
        },
      }),
    ).toThrow(/exactly one/u);
  });

  it('rejects a bare-head comparison control relabeled as authoritative gameplay', () => {
    const plan = headwearPlan();
    const equipped = plan.scenes.find((scene) => scene.id === 'head_steve_front_full');
    if (equipped?.fixture.kind !== 'equippable_head') {
      throw new Error('Missing equipped headwear fixture.');
    }
    const bareControl: ClientCaptureScene = {
      ...equipped,
      id: 'head_bare_steve',
      baseSceneId: 'head_bare_steve',
      viewKind: 'minecraft_vanilla',
      requiredForAuthority: true,
      fixture: { ...equipped.fixture, subject: 'bare_control', chestArmor: false },
      measurementIntents: [],
      comparisonSceneIds: [equipped.id],
    };
    expect(() =>
      createClientCapturePlan({
        schemaVersion: plan.schemaVersion,
        kind: plan.kind,
        minecraftVersion: plan.minecraftVersion,
        provenance: plan.provenance,
        studio: plan.studio,
        scenes: [...plan.scenes, bareControl],
        execution: plan.execution,
      }),
    ).toThrow(/bare-head control.*supplemental/u);
  });

  it('hash-binds exact display transforms and separates client ticks from render settling frames', () => {
    const plan = blockDisplayPlan();
    const plannedScene = plan.scenes[0];
    if (plannedScene === undefined) throw new Error('Expected a display scene.');
    const originalHash = computeClientCaptureAppliedFixtureSha256(
      plan.provenance.representation,
      plannedScene,
    );
    const changed = structuredClone(blockDisplayRepresentation);
    changed.states.default.blockDisplay.transform.translation[0] = 0.25;
    expect(
      computeClientCaptureAppliedFixtureSha256(
        ClientCaptureRepresentationSchema.parse(changed),
        plannedScene,
      ),
    ).not.toBe(originalHash);
    expect(() =>
      ClientCaptureRepresentationSchema.parse({
        ...blockDisplayRepresentation,
        states: {
          default: { blockState: { id: 'minecraft:stone', properties: {} } },
        },
      }),
    ).toThrow();
    const interpolated = structuredClone(blockDisplayRepresentation);
    interpolated.states.default.blockDisplay.interpolation.duration = 4;
    expect(() => ClientCaptureRepresentationSchema.parse(interpolated)).toThrow(
      /only static display nodes/u,
    );
    expect(() =>
      ClientCaptureRepresentationSchema.parse({
        targetKind: 'block',
        strategy: 'native_block_state',
        capability: 'replacement',
        states: { default: { blockState: { id: 'minecraft:stone', properties: {} } } },
        review: {
          transparency: false,
          biomeTintBiomes: [],
          animatedTextureTicks: [4],
        },
      }),
    ).toThrow(/global atlas animation phase/u);

    const fixture = completeFixture(plan);
    expect(() => parseClientCaptureReport(fixture.report, plan)).not.toThrow();
    expect(() =>
      parseClientCaptureReport(
        {
          ...fixture.report,
          views: fixture.report.views.map((view) => ({ ...view, renderedSettleFrames: 2 })),
        },
        plan,
      ),
    ).toThrow(/settling interval/u);
    expect(fixture.report.views[0]).toMatchObject({
      actualSettledTicks: 40,
      renderedSettleFrames: 3,
    });
  });

  it('verifies complete framebuffers, readiness evidence, hashes, and explicit skipped pixel metrics', async () => {
    const plan = createClientCapturePlan(planInput());
    const fixture = completeFixture(plan);
    const artifacts = new Map(fixture.pngs);
    artifacts.set(fixture.report.log.path, fixture.log);

    const evidence = await verifyClientCaptureComplete(plan, fixture.report, {
      readArtifact: (artifactPath) => {
        const value = artifacts.get(artifactPath);
        return value === undefined
          ? Promise.reject(new Error('missing fixture'))
          : Promise.resolve(value);
      },
    });
    expect(evidence.views).toHaveLength(plan.scenes.length);
    expect(evidence.report.measurements.every((entry) => entry.status === 'skipped')).toBe(true);

    expect(() =>
      parseClientCaptureReport(
        {
          ...fixture.report,
          runtime: { ...fixture.report.runtime, studioSha256: '9'.repeat(64) },
        },
        plan,
      ),
    ).toThrow(/studio settings/u);
    expect(() =>
      parseClientCaptureReport(
        {
          ...fixture.report,
          views: fixture.report.views.map((view, index) =>
            index === 0 ? { ...view, actualScaleReferenceSha256: '9'.repeat(64) } : view,
          ),
        },
        plan,
      ),
    ).toThrow(/scale-reference readback/u);
    expect(() =>
      parseClientCaptureReport(
        {
          ...fixture.report,
          views: fixture.report.views.map((view, index) => {
            if (index !== 0) return view;
            const altered = structuredClone(view) as unknown as {
              actualScaleReference: { secondBlock: { id: string } };
            };
            altered.actualScaleReference.secondBlock.id = 'minecraft:red_concrete';
            return altered;
          }),
        },
        plan,
      ),
    ).toThrow();
    expect(() =>
      parseClientCaptureReport(
        {
          ...fixture.report,
          views: fixture.report.views.map((view, index) =>
            index === 0 ? { ...view, modelBakeReady: false } : view,
          ),
        },
        plan,
      ),
    ).toThrow();
    expect(() =>
      parseClientCaptureReport(
        {
          ...fixture.report,
          views: fixture.report.views.map((view, index) =>
            index === 0
              ? {
                  ...view,
                  actualFov: view.actualFov + 1,
                  actualCameraPose: { ...view.actualCameraPose, x: view.actualCameraPose.x + 1 },
                }
              : view,
          ),
        },
        plan,
      ),
    ).toThrow(/render-camera pose|runtime camera/u);
  });

  it('rejects relabeled or forged authoritative pixel measurements', async () => {
    const threshold = { comparison: 'below' as const, warning: 0.1, failure: 0 };
    const control = { ...scene('control'), measurementIntents: [] };
    const variant = {
      ...scene('variant'),
      comparisonSceneIds: ['control'],
      measurementIntents: [
        {
          id: 'm_variant_delta',
          metric: 'pairwise_pixel_delta' as const,
          authority: 'client_pixels' as const,
          unit: 'percent' as const,
          requiredForReadiness: true,
          threshold,
        },
      ],
    };
    const plan = createClientCapturePlan({ ...planInput(), scenes: [control, variant] });
    const fixture = completeFixture(plan);
    const byScene = new Map(fixture.report.views.map((view) => [view.sceneId, view]));
    const hashes = ['control', 'variant'].map((sceneId) => {
      const view = byScene.get(sceneId);
      if (view === undefined) throw new Error('Missing pixel fixture view.');
      return view.pngSha256;
    });
    const measured = {
      id: 'm_variant_delta',
      metric: 'pairwise_pixel_delta' as const,
      authority: 'client_pixels' as const,
      requiredForReadiness: true,
      sceneIds: ['control', 'variant'],
      status: 'failed' as const,
      unit: 'percent' as const,
      value: 0,
      threshold,
      message: 'The two exact Minecraft framebuffers are pixel-identical.',
      sourcePngSha256s: hashes,
    };
    const report = { ...fixture.report, measurements: [measured] };
    expect(() => parseClientCaptureReport(report, plan)).not.toThrow();
    for (const altered of [
      { ...measured, status: 'passed' as const },
      { ...measured, requiredForReadiness: false },
      { ...measured, threshold: { ...threshold, warning: 10 } },
    ]) {
      expect(() =>
        parseClientCaptureReport({ ...report, measurements: [altered] }, plan),
      ).toThrow();
    }
    expect(() =>
      parseClientCaptureReport(
        {
          ...report,
          measurements: [
            { ...measured, status: 'skipped' as const, value: undefined, sourcePngSha256s: [] },
          ],
        },
        plan,
      ),
    ).not.toThrow();

    const artifacts = new Map(fixture.pngs);
    artifacts.set(fixture.report.log.path, fixture.log);
    await expect(
      verifyClientCaptureComplete(
        plan,
        {
          ...report,
          measurements: [{ ...measured, status: 'passed', value: 1 }],
        },
        {
          readArtifact: (artifactPath) => {
            const value = artifacts.get(artifactPath);
            return value === undefined
              ? Promise.reject(new Error('missing fixture'))
              : Promise.resolve(value);
          },
        },
      ),
    ).rejects.toThrow(/hashed framebuffer pixels/u);
  });

  it('verifies a confined completion sentinel and rejects symlinked artifacts', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'packwright-v3-output-'));
    cleanups.push(root);
    const gameDirectory = path.join(root, 'game');
    const outputDirectory = path.join(gameDirectory, 'output');
    await mkdir(path.join(outputDirectory, 'views'), { recursive: true });
    await mkdir(path.join(outputDirectory, 'logs'), { recursive: true });
    const plan = createClientCapturePlan(
      planInput('capture-output', gameDirectory, outputDirectory),
    );
    const fixture = completeFixture(plan);
    for (const [artifactPath, bytes] of fixture.pngs) {
      await writeFile(path.join(outputDirectory, artifactPath), bytes);
    }
    await writeFile(path.join(outputDirectory, fixture.report.log.path), fixture.log);
    const reportBytes = canonicalJsonBytes(fixture.report);
    await writeFile(path.join(outputDirectory, 'capture-report.json'), reportBytes);
    const sentinel = canonicalJsonBytes({
      schemaVersion: 3,
      kind: 'packwright.client-capture-complete',
      executionId: plan.execution.executionId,
      planSha256: plan.planSha256,
      report: {
        path: 'capture-report.json',
        sha256: sha256Buffer(reportBytes),
        bytes: reportBytes.length,
      },
    });
    await writeFile(path.join(outputDirectory, 'capture-complete.json'), sentinel);

    const verified = await verifyClientCaptureOutput({ plan, outputDirectory });
    expect(verified.reportArtifact.sha256).toBe(sha256Buffer(reportBytes));

    const firstView = fixture.report.views[0];
    if (firstView === undefined) throw new Error('Expected a capture view.');
    await rm(path.join(outputDirectory, firstView.path));
    await symlink('/etc/hosts', path.join(outputDirectory, firstView.path));
    await expect(verifyClientCaptureOutput({ plan, outputDirectory })).rejects.toThrow(
      /symbolic link/u,
    );
  });

  it('reads and hash-checks v2 metadata without silently reinterpreting it as v3', () => {
    const body = {
      schemaVersion: 2 as const,
      kind: 'packwright.client-capture-plan' as const,
      minecraftVersion: '26.2' as const,
      provenance: { projectId: 'legacy' },
      scenes: [{ id: 'legacy_scene' }],
    };
    const legacy = {
      ...body,
      execution: {
        executionId: 'legacy-001',
        gameDirectory: '/private/tmp/legacy-game',
        outputDirectory: '/private/tmp/legacy-game/output',
      },
      planSha256: sha256Buffer(canonicalJsonBytes(body)),
    };
    expect(parseLegacyClientCapturePlanMetadata(legacy)).toMatchObject({
      schemaVersion: 2,
      sceneCount: 1,
      recaptureRequired: true,
    });
    expect(() => parseClientCapturePlan(legacy)).toThrow(/immutable legacy evidence/u);
    expect(() =>
      parseLegacyClientCapturePlanMetadata({ ...legacy, planSha256: '9'.repeat(64) }),
    ).toThrow(/v2 stable identity/u);
  });

  it('keeps the stable hash independent of launch paths but sensitive to studio changes', () => {
    const plan = createClientCapturePlan(planInput());
    expect(computeClientCapturePlanSha256(plan)).toBe(plan.planSha256);
    const changed = createClientCapturePlan({
      ...planInput(),
      studio: { ...studio, renderDistance: 12 },
    });
    expect(changed.planSha256).not.toBe(plan.planSha256);
  });
});
