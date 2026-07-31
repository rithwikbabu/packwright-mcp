import {
  compareVisualStrings,
  type CompiledItemAsset,
  type ItemBindingProposal,
} from './compiler.js';

export const ASSET_GRAPH_SCHEMA_VERSION = 1 as const;

export type AssetNodeKind =
  'logical_item' | 'carrier_item' | 'item_component' | 'item_definition' | 'model' | 'texture';

export type AssetEdgeKind =
  | 'implemented_by'
  | 'uses_component'
  | 'resolves_to'
  | 'selects_model'
  | 'inherits_model'
  | 'uses_texture';

export interface AssetNode {
  /** Graph identity, not necessarily a Minecraft resource identifier. */
  readonly id: string;
  readonly kind: AssetNodeKind;
  readonly resourceId?: string | undefined;
  readonly path?: string | undefined;
  readonly generated: boolean;
  readonly external: boolean;
  readonly metadata?: Readonly<Record<string, string | number | boolean>> | undefined;
}

export interface AssetEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: AssetEdgeKind;
}

export interface VisualAssetGraph {
  readonly schemaVersion: typeof ASSET_GRAPH_SCHEMA_VERSION;
  readonly projectId: string;
  readonly nodes: readonly AssetNode[];
  readonly edges: readonly AssetEdge[];
}

function nodeId(kind: AssetNodeKind, resourceId: string): string {
  return `${kind}:${resourceId}`;
}

function addNode(nodes: AssetNode[], node: AssetNode): void {
  const existing = nodes.find((candidate) => candidate.id === node.id);
  if (existing === undefined) {
    nodes.push(node);
    return;
  }
  if (
    existing.kind !== node.kind ||
    existing.resourceId !== node.resourceId ||
    existing.path !== node.path ||
    existing.generated !== node.generated ||
    existing.external !== node.external ||
    JSON.stringify(existing.metadata) !== JSON.stringify(node.metadata)
  ) {
    // Preserve incompatible duplicates so validation can return a complete diagnostic.
    nodes.push(node);
  }
}

function addEdge(edges: AssetEdge[], edge: AssetEdge): void {
  if (
    !edges.some(
      (candidate) =>
        candidate.from === edge.from && candidate.to === edge.to && candidate.kind === edge.kind,
    )
  ) {
    edges.push(edge);
  }
}

/**
 * Materialize the complete item-component → item-definition → model → texture graph for a
 * compiled custom item. External state models and imported textures remain explicit graph nodes.
 */
export function createItemAssetGraph(
  compiled: CompiledItemAsset,
  binding: ItemBindingProposal,
  projectId = compiled.spec.id,
): VisualAssetGraph {
  if (binding.logicalItem !== compiled.spec.id) {
    throw new Error(
      `Binding '${binding.logicalItem}' does not describe compiled asset '${compiled.spec.id}'.`,
    );
  }

  const nodes: AssetNode[] = [];
  const edges: AssetEdge[] = [];
  const logicalId = nodeId('logical_item', compiled.spec.id);
  const carrierId = nodeId('carrier_item', `${binding.carrierItem}@${compiled.spec.id}`);
  const componentId = nodeId('item_component', `${compiled.spec.id}/minecraft:item_model`);
  const definitionId = nodeId('item_definition', compiled.itemDefinitionResourceId);
  const modelId = nodeId('model', compiled.modelResourceId);
  const parentModelId = nodeId('model', compiled.parentModelResourceId);
  const definitionFile = compiled.files.find((file) => file.role === 'item_definition');
  const modelFile = compiled.files.find((file) => file.role === 'model');

  addNode(nodes, {
    id: logicalId,
    kind: 'logical_item',
    resourceId: compiled.spec.id,
    generated: true,
    external: false,
    metadata: {
      bindingId: binding.id,
      strategy: binding.strategy,
      carrierItem: binding.carrierItem,
      itemModel: binding.component.value,
    },
  });
  addNode(nodes, {
    id: carrierId,
    kind: 'carrier_item',
    resourceId: binding.carrierItem,
    generated: false,
    external: true,
  });
  addNode(nodes, {
    id: componentId,
    kind: 'item_component',
    resourceId: binding.component.id,
    generated: true,
    external: false,
    metadata: { value: binding.component.value },
  });
  addNode(nodes, {
    id: definitionId,
    kind: 'item_definition',
    resourceId: compiled.itemDefinitionResourceId,
    ...(definitionFile?.path === undefined ? {} : { path: definitionFile.path }),
    generated: true,
    external: false,
  });
  addNode(nodes, {
    id: modelId,
    kind: 'model',
    resourceId: compiled.modelResourceId,
    ...(modelFile?.path === undefined ? {} : { path: modelFile.path }),
    generated: true,
    external: false,
  });
  addNode(nodes, {
    id: parentModelId,
    kind: 'model',
    resourceId: compiled.parentModelResourceId,
    generated: false,
    external: true,
  });

  addEdge(edges, { from: logicalId, to: carrierId, kind: 'implemented_by' });
  addEdge(edges, { from: carrierId, to: componentId, kind: 'uses_component' });
  addEdge(edges, { from: componentId, to: definitionId, kind: 'resolves_to' });
  addEdge(edges, { from: definitionId, to: modelId, kind: 'selects_model' });
  addEdge(edges, { from: modelId, to: parentModelId, kind: 'inherits_model' });

  for (const texture of compiled.textures) {
    const textureId = nodeId('texture', texture.resourceId);
    addNode(nodes, {
      id: textureId,
      kind: 'texture',
      resourceId: texture.resourceId,
      ...(texture.external ? {} : { path: texture.path }),
      generated: !texture.external,
      external: texture.external,
      metadata: {
        width: texture.width,
        height: texture.height,
        materialId: texture.materialId,
      },
    });
    addEdge(edges, { from: modelId, to: textureId, kind: 'uses_texture' });
  }

  for (const reference of compiled.externalModelReferences) {
    const referenceId = nodeId('model', reference);
    addNode(nodes, {
      id: referenceId,
      kind: 'model',
      resourceId: reference,
      generated: false,
      external: true,
    });
    addEdge(edges, { from: definitionId, to: referenceId, kind: 'selects_model' });
  }

  return {
    schemaVersion: ASSET_GRAPH_SCHEMA_VERSION,
    projectId,
    nodes: nodes.sort((left, right) => compareVisualStrings(left.id, right.id)),
    edges: edges.sort(compareEdges),
  };
}

function compareEdges(left: AssetEdge, right: AssetEdge): number {
  const from = compareVisualStrings(left.from, right.from);
  if (from !== 0) return from;
  const to = compareVisualStrings(left.to, right.to);
  if (to !== 0) return to;
  return compareVisualStrings(left.kind, right.kind);
}

/** Combine item graphs while preserving intentional shared carrier and texture nodes. */
export function mergeAssetGraphs(
  projectId: string,
  ...graphs: readonly VisualAssetGraph[]
): VisualAssetGraph {
  const nodes: AssetNode[] = [];
  const edges: AssetEdge[] = [];
  for (const graph of graphs) {
    for (const node of graph.nodes) addNode(nodes, node);
    for (const edge of graph.edges) addEdge(edges, edge);
  }
  return {
    schemaVersion: ASSET_GRAPH_SCHEMA_VERSION,
    projectId,
    nodes: nodes.sort((left, right) => compareVisualStrings(left.id, right.id)),
    edges: edges.sort(compareEdges),
  };
}

export function findAssetNode(
  graph: VisualAssetGraph,
  kind: AssetNodeKind,
  resourceId: string,
): AssetNode | undefined {
  return graph.nodes.find((node) => node.kind === kind && node.resourceId === resourceId);
}

/**
 * Select an asset and its immediate dependencies/dependants without returning dangling edges.
 * Both graph node IDs and Minecraft resource IDs are accepted as selectors.
 */
export function selectAssetSubgraph(graph: VisualAssetGraph, assetId: string): VisualAssetGraph {
  const selected = new Set(
    graph.nodes
      .filter((node) => node.id === assetId || node.resourceId === assetId)
      .map((node) => node.id),
  );
  if (selected.size === 0) {
    return { ...graph, nodes: [], edges: [] };
  }

  const roots = new Set(selected);
  for (const edge of graph.edges) {
    if (roots.has(edge.from) || roots.has(edge.to)) {
      selected.add(edge.from);
      selected.add(edge.to);
    }
  }
  const nodes = graph.nodes.filter((node) => selected.has(node.id));
  const retained = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => retained.has(edge.from) && retained.has(edge.to));
  return { ...graph, nodes, edges };
}
