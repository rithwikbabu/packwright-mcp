export const fireStaffInput = {
  id: 'arcana:firestaff',
  targetKind: 'item',
  template: 'handheld_3d',
  textureSize: [32, 32],
  materials: {
    dark_oak: { texture: 'arcana:item/firestaff/dark_oak' },
    fire_crystal: { color: '#ff6a00', emissive: true, tintIndex: 0 },
  },
  parts: [
    {
      id: 'handle',
      shape: 'cuboid',
      from: [7, 0, 7],
      to: [9, 13, 9],
      material: 'dark_oak',
      uvMode: 'box',
    },
    {
      id: 'crystal',
      shape: 'cuboid',
      from: [6, 12, 6],
      to: [10, 16, 10],
      material: 'fire_crystal',
      parent: 'handle',
      rotation: { axis: 'y', angle: 22.5, pivot: [8, 14, 8] },
    },
    {
      id: 'flare',
      shape: 'plane',
      from: [5, 13, 8],
      to: [11, 16, 8],
      material: 'fire_crystal',
    },
  ],
  displayPreset: 'handheld_3d',
  reviewProfile: 'held_item',
  heldItem: {
    primaryGrip: [8, 5.5, 11],
    muzzle: [8, 15, 8],
    forwardAxis: [0, 0, -1],
    handedness: 'either',
    twoHanded: false,
    itemKind: 'generic',
    usePose: 'aim',
  },
  states: [
    {
      id: 'casting',
      kind: 'condition',
      property: 'minecraft:using_item',
      model: 'arcana:item/firestaff_casting',
    },
    {
      id: 'charge',
      kind: 'range_dispatch',
      property: 'minecraft:use_duration',
      scale: 0.05,
      entries: [
        { threshold: 10, model: 'arcana:item/firestaff_hot' },
        { threshold: 2, model: 'arcana:item/firestaff_warm' },
      ],
    },
  ],
  connection: {
    carrierItem: 'minecraft:blaze_rod',
  },
} as const;
