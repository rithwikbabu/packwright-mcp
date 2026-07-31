import { describe, expect, it } from 'vitest';
import {
  createItemAssetGraph,
  findAssetNode,
  mergeAssetGraphs,
  selectAssetSubgraph,
  type VisualAssetGraph,
} from '../../src/visual/asset-graph.js';
import { compileItemAsset, createItemBindingProposal } from '../../src/visual/compiler.js';
import {
  formatVisualDiagnostic,
  validateAssetGraph,
  validateVisualAsset,
} from '../../src/visual/visual-validation.js';
import { fireStaffInput } from './fixtures.js';

function fixture() {
  const compiled = compileItemAsset(fireStaffInput);
  const binding = createItemBindingProposal(compiled.spec, compiled);
  const graph = createItemAssetGraph(compiled, binding, 'firestaff');
  return { compiled, binding, graph };
}

describe('visual asset graph', () => {
  it('connects the logical item, carrier, component, item definition, model, and textures', () => {
    const { compiled, graph } = fixture();
    expect(findAssetNode(graph, 'carrier_item', 'minecraft:blaze_rod')).toBeDefined();
    expect(findAssetNode(graph, 'item_definition', 'arcana:firestaff')).toMatchObject({
      path: 'assets/arcana/items/firestaff.json',
    });
    expect(findAssetNode(graph, 'model', 'arcana:item/firestaff')).toMatchObject({
      path: 'assets/arcana/models/item/firestaff.json',
    });
    expect(validateAssetGraph(graph)).toEqual([]);

    const result = validateVisualAsset(compiled.spec, compiled, graph, {
      availableTextureResourceIds: new Set(
        compiled.textures
          .filter((texture) => !texture.external)
          .map((texture) => texture.resourceId),
      ),
      availableModelResourceIds: new Set(compiled.externalModelReferences),
    });
    expect(result.ok).toBe(true);
    expect(result.filesChecked).toBe(2);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'visual.material.emissive_intent' }),
    );
  });

  it('diagnoses missing endpoints, cycles, orphans, and invalid item-model chains', () => {
    const { graph } = fixture();
    const logical = graph.nodes.find((node) => node.kind === 'logical_item');
    const damaged: VisualAssetGraph = {
      ...graph,
      nodes: [
        ...graph.nodes.filter((node) => node.kind !== 'item_component'),
        {
          id: 'model:arcana:item/orphaned',
          kind: 'model',
          resourceId: 'arcana:item/orphaned',
          generated: true,
          external: false,
        },
      ],
      edges: [
        ...graph.edges,
        {
          from: 'model:arcana:item/firestaff',
          to: logical?.id ?? 'logical_item:arcana:firestaff',
          kind: 'selects_model',
        },
      ],
    };
    const codes = validateAssetGraph(damaged).map((entry) => entry.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'visual.graph.missing_endpoint',
        'visual.graph.cycle',
        'visual.graph.orphan',
        'visual.binding.item_model_component',
      ]),
    );
  });

  it('preserves conflicting logical bindings when graphs are merged so they can be diagnosed', () => {
    const { compiled, graph } = fixture();
    const alternate = createItemAssetGraph(
      compiled,
      createItemBindingProposal(compiled.spec, compiled, 'minecraft:carrot_on_a_stick'),
      'firestaff',
    );
    const merged = mergeAssetGraphs('combined', graph, alternate);
    expect(validateAssetGraph(merged)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'visual.graph.duplicate_node', severity: 'error' }),
        expect.objectContaining({ code: 'visual.binding.conflicting_carrier', severity: 'error' }),
      ]),
    );
  });

  it('formats diagnostics using semantic part and material identities', () => {
    expect(
      formatVisualDiagnostic({
        engine: 'packwright.visual',
        authority: 'structural',
        severity: 'error',
        code: 'visual.uv.bounds',
        message: 'Texture UV extends outside its assigned region.',
        target: 'arcana:firestaff',
        partId: 'crystal',
        suggestedFix: 'Move the UV inward.',
      }),
    ).toBe(
      'arcana:firestaff / part crystal\nTexture UV extends outside its assigned region.\nMove the UV inward.',
    );
  });

  it('selects an asset with one-hop neighbors and never returns dangling edges', () => {
    const { graph } = fixture();
    const selected = selectAssetSubgraph(graph, 'arcana:item/firestaff');
    const nodeIds = new Set(selected.nodes.map((node) => node.id));

    expect(selected.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'item_definition' }),
        expect.objectContaining({ kind: 'model', resourceId: 'arcana:item/firestaff' }),
        expect.objectContaining({ kind: 'texture' }),
      ]),
    );
    expect(selected.edges.every((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))).toBe(
      true,
    );
    expect(selectAssetSubgraph(graph, 'arcana:missing')).toMatchObject({ nodes: [], edges: [] });
  });
});
