import { sha256Buffer } from '../core/hash.js';
import type { AssetEdge, AssetNode, VisualAssetGraph } from './asset-graph.js';
import {
  compareVisualStrings,
  compileItemAsset,
  type CompiledItemAsset,
  type ModelFace,
  type UvAssignment,
} from './compiler.js';
import { safeParseModelSpec, type DisplayContext, type ModelSpec } from './model-spec.js';

export type VisualDiagnosticSeverity = 'error' | 'warning' | 'information';

export interface VisualDiagnostic {
  readonly engine: 'packwright.visual';
  readonly authority: 'structural' | 'advisory';
  readonly severity: VisualDiagnosticSeverity;
  readonly code: string;
  readonly message: string;
  readonly target?: string | undefined;
  readonly partId?: string | undefined;
  readonly materialId?: string | undefined;
  readonly displayContext?: DisplayContext | undefined;
  readonly reviewProfile?: string | undefined;
  readonly reviewView?: string | undefined;
  readonly reviewMetric?: string | undefined;
  readonly path?: string | undefined;
  readonly suggestedFix?: string | undefined;
}

export interface VisualValidationOptions {
  /** When supplied, unresolved non-external textures are errors. */
  readonly availableTextureResourceIds?: ReadonlySet<string> | undefined;
  /** When supplied, state models not present in this set are errors. */
  readonly availableModelResourceIds?: ReadonlySet<string> | undefined;
}

export interface VisualValidationResult {
  readonly ok: boolean;
  readonly diagnostics: readonly VisualDiagnostic[];
  readonly filesChecked: number;
  readonly graphNodesChecked: number;
}

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

/** Convert strict ModelSpec schema failures into stable, semantic diagnostics. */
export function validateModelSpec(input: unknown): readonly VisualDiagnostic[] {
  const parsed = safeParseModelSpec(input);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => {
      const path = issue.path.map(String);
      const partIndex = path[0] === 'parts' ? Number(path[1]) : undefined;
      const candidate =
        partIndex === undefined || !Number.isInteger(partIndex)
          ? undefined
          : (input as { parts?: { id?: unknown }[] } | null)?.parts?.[partIndex]?.id;
      const target = (input as { id?: unknown } | null)?.id;
      return diagnostic('visual.spec.invalid', 'error', issue.message, {
        ...(typeof target === 'string' ? { target } : {}),
        ...(typeof candidate === 'string' ? { partId: candidate } : {}),
        path: path.join('.'),
      });
    });
  }

  const spec = parsed.data;
  const diagnostics: VisualDiagnostic[] = [];
  const usedMaterials = new Set(spec.parts.map((part) => part.material));
  const tintOwners = new Map<number, { materialId: string; color: string }>();
  for (const materialId of Object.keys(spec.materials).sort(compareVisualStrings)) {
    const material = spec.materials[materialId];
    if (!usedMaterials.has(materialId)) {
      diagnostics.push(
        diagnostic(
          'visual.material.unused',
          'warning',
          `Material '${materialId}' is declared but no model part uses it.`,
          { target: spec.id, materialId },
        ),
      );
    }
    if (material?.emissive) {
      diagnostics.push(
        diagnostic(
          'visual.material.emissive_intent',
          'information',
          `Material '${materialId}' records emissive intent; the vanilla item model compiler does not claim true emissive rendering.`,
          { target: spec.id, materialId },
        ),
      );
    }
    if (material?.tintIndex !== undefined) {
      const color = material.color?.slice(0, 7).toLowerCase() ?? '#ffffff';
      const owner = tintOwners.get(material.tintIndex);
      if (owner !== undefined && owner.color !== color) {
        diagnostics.push(
          diagnostic(
            'visual.tint.conflict',
            'error',
            `Materials '${owner.materialId}' and '${materialId}' assign different colors to tint index ${String(material.tintIndex)}.`,
            {
              target: spec.id,
              materialId,
              suggestedFix: 'Assign a unique tintIndex or use the same color for both materials.',
            },
          ),
        );
      } else {
        tintOwners.set(material.tintIndex, { materialId, color });
      }
    }
  }

  for (const [context, transform] of Object.entries(spec.display) as [
    DisplayContext,
    NonNullable<ModelSpec['display'][DisplayContext]>,
  ][]) {
    if (mayClipDisplay(spec, transform)) {
      diagnostics.push(
        diagnostic(
          'visual.display.may_clip',
          'warning',
          `The '${context}' transform may move geometry outside the standard preview volume.`,
          {
            target: spec.id,
            displayContext: context,
            suggestedFix: `Reduce ${context} scale or translation and render the context preview again.`,
          },
        ),
      );
    }
  }
  return diagnostics;
}

function mayClipDisplay(
  spec: ModelSpec,
  transform: NonNullable<ModelSpec['display'][DisplayContext]>,
): boolean {
  for (const axis of [0, 1, 2] as const) {
    const minimum = Math.min(...spec.parts.map((part) => part.from[axis]));
    const maximum = Math.max(...spec.parts.map((part) => part.to[axis]));
    const center = (minimum + maximum) / 2;
    const halfExtent = ((maximum - minimum) / 2) * transform.scale[axis];
    const transformedCenter =
      (center - 8) * transform.scale[axis] + 8 + transform.translation[axis];
    if (transformedCenter - halfExtent < -16 || transformedCenter + halfExtent > 32) return true;
  }
  return false;
}

function validateUvAssignment(
  target: string,
  assignment: UvAssignment,
): VisualDiagnostic | undefined {
  const [x0, y0, x1, y1] = assignment.pixelBounds;
  if (x0 === x1 || y0 === y1) {
    return diagnostic(
      'visual.uv.insufficient_texture_space',
      'error',
      `The ${assignment.face} face has a zero-pixel UV region in its assigned texture.`,
      {
        target,
        partId: assignment.partId,
        materialId: assignment.materialId,
        suggestedFix: 'Increase textureSize or reduce the number of faces sharing this material.',
      },
    );
  }
  return undefined;
}

function parseJsonFile(
  target: string,
  path: string,
  content: string,
): { value?: unknown; diagnostic?: VisualDiagnostic } {
  try {
    return { value: JSON.parse(content) as unknown };
  } catch (error) {
    return {
      diagnostic: diagnostic(
        'visual.compiled.invalid_json',
        'error',
        `Compiled JSON is malformed: ${error instanceof Error ? error.message : String(error)}`,
        { target, path },
      ),
    };
  }
}

export function validateCompiledItemAsset(
  compiled: CompiledItemAsset,
  options: VisualValidationOptions = {},
): readonly VisualDiagnostic[] {
  const diagnostics: VisualDiagnostic[] = [];
  const expected = compileItemAsset(compiled.spec);
  const paths = new Set<string>();
  for (const file of compiled.files) {
    if (paths.has(file.path)) {
      diagnostics.push(
        diagnostic(
          'visual.compiled.duplicate_path',
          'error',
          `Compiled output path '${file.path}' is duplicated.`,
          { target: compiled.spec.id, path: file.path },
        ),
      );
    }
    paths.add(file.path);
    if (sha256Buffer(file.content) !== file.sha256) {
      diagnostics.push(
        diagnostic(
          'visual.compiled.hash_mismatch',
          'error',
          `Compiled output '${file.path}' no longer matches its content hash.`,
          { target: compiled.spec.id, path: file.path },
        ),
      );
    }
    const parsed = parseJsonFile(compiled.spec.id, file.path, file.content);
    if (parsed.diagnostic !== undefined) diagnostics.push(parsed.diagnostic);
    const canonical = expected.files.find((candidate) => candidate.role === file.role);
    if (
      canonical?.path !== file.path ||
      canonical.resourceId !== file.resourceId ||
      canonical.content !== file.content
    ) {
      diagnostics.push(
        diagnostic(
          'visual.compiled.noncanonical',
          'error',
          `Compiled output '${file.path}' does not match the canonical Minecraft 26.2 output for its ModelSpec.`,
          {
            target: compiled.spec.id,
            path: file.path,
            suggestedFix:
              'Compile the current ModelSpec again instead of editing draft JSON directly.',
          },
        ),
      );
    }
  }

  if (compiled.files.filter((file) => file.role === 'item_definition').length !== 1) {
    diagnostics.push(
      diagnostic(
        'visual.compiled.item_definition_count',
        'error',
        'A compiled item must contain exactly one client item definition.',
        { target: compiled.spec.id },
      ),
    );
  }
  if (compiled.files.filter((file) => file.role === 'model').length !== 1) {
    diagnostics.push(
      diagnostic(
        'visual.compiled.model_count',
        'error',
        'A compiled item must contain exactly one generated geometry model.',
        { target: compiled.spec.id },
      ),
    );
  }

  for (const assignment of compiled.uvLayout) {
    const issue = validateUvAssignment(compiled.spec.id, assignment);
    if (issue !== undefined) diagnostics.push(issue);
  }

  if (options.availableTextureResourceIds !== undefined) {
    for (const texture of compiled.textures) {
      if (!texture.external && !options.availableTextureResourceIds.has(texture.resourceId)) {
        diagnostics.push(
          diagnostic(
            'visual.texture.missing',
            'error',
            `Required texture '${texture.resourceId}' has not been imported or generated.`,
            {
              target: compiled.spec.id,
              materialId: texture.materialId,
              path: texture.path,
              suggestedFix: `Import a ${String(texture.width)}×${String(texture.height)} PNG for material '${texture.materialId}'.`,
            },
          ),
        );
      }
    }
  }

  if (options.availableModelResourceIds !== undefined) {
    for (const model of compiled.externalModelReferences) {
      if (!options.availableModelResourceIds.has(model)) {
        diagnostics.push(
          diagnostic(
            'visual.model.missing_state_model',
            'error',
            `Item state references missing model '${model}'.`,
            { target: compiled.spec.id },
          ),
        );
      }
    }
  }
  return diagnostics;
}

function outgoing(graph: VisualAssetGraph, id: string, kind?: AssetEdge['kind']): AssetEdge[] {
  return graph.edges.filter(
    (edge) => edge.from === id && (kind === undefined || edge.kind === kind),
  );
}

function nodeById(graph: VisualAssetGraph, id: string): AssetNode | undefined {
  return graph.nodes.find((node) => node.id === id);
}

function describeCycle(path: readonly string[]): string {
  return path.join(' -> ');
}

function findCycles(graph: VisualAssetGraph): readonly (readonly string[])[] {
  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const targets = adjacency.get(edge.from) ?? [];
    targets.push(edge.to);
    adjacency.set(edge.from, targets);
  }
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  function visit(id: string): void {
    if (active.has(id)) {
      const index = stack.indexOf(id);
      cycles.push([...stack.slice(index), id]);
      return;
    }
    if (visited.has(id)) return;
    visited.add(id);
    active.add(id);
    stack.push(id);
    for (const target of adjacency.get(id) ?? []) visit(target);
    stack.pop();
    active.delete(id);
  }

  for (const node of graph.nodes) visit(node.id);
  return cycles;
}

/** Validate referential integrity and connection semantics across a paired-pack asset graph. */
export function validateAssetGraph(graph: VisualAssetGraph): readonly VisualDiagnostic[] {
  const diagnostics: VisualDiagnostic[] = [];
  const ids = new Set<string>();
  const paths = new Map<string, string>();

  for (const node of graph.nodes) {
    if (ids.has(node.id)) {
      diagnostics.push(
        diagnostic(
          'visual.graph.duplicate_node',
          'error',
          `Asset graph node '${node.id}' is duplicated.`,
          { target: node.resourceId },
        ),
      );
    }
    ids.add(node.id);
    if (node.path !== undefined) {
      const owner = paths.get(node.path);
      if (owner !== undefined && owner !== node.id) {
        diagnostics.push(
          diagnostic(
            'visual.graph.conflicting_path',
            'error',
            `Generated path '${node.path}' is owned by both '${owner}' and '${node.id}'.`,
            { target: node.resourceId, path: node.path },
          ),
        );
      }
      paths.set(node.path, node.id);
    }
  }

  for (const edge of graph.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      diagnostics.push(
        diagnostic(
          'visual.graph.missing_endpoint',
          'error',
          `Graph edge '${edge.from}' → '${edge.to}' references a missing node.`,
        ),
      );
    }
  }

  for (const cycle of findCycles(graph)) {
    diagnostics.push(
      diagnostic(
        'visual.graph.cycle',
        'error',
        `Asset references form a cycle: ${describeCycle(cycle)}.`,
      ),
    );
  }

  const incoming = new Set(graph.edges.map((edge) => edge.to));
  for (const node of graph.nodes) {
    if (node.kind !== 'logical_item' && !incoming.has(node.id)) {
      diagnostics.push(
        diagnostic(
          'visual.graph.orphan',
          'warning',
          `Asset '${node.resourceId ?? node.id}' is not reachable from a logical item.`,
          { target: node.resourceId, path: node.path },
        ),
      );
    }
  }

  for (const logical of graph.nodes.filter((node) => node.kind === 'logical_item')) {
    const carriers = outgoing(graph, logical.id, 'implemented_by')
      .map((edge) => nodeById(graph, edge.to))
      .filter((node): node is AssetNode => node !== undefined);
    if (carriers.length !== 1 || carriers[0]?.kind !== 'carrier_item') {
      diagnostics.push(
        diagnostic(
          'visual.binding.carrier',
          'error',
          `Logical item '${logical.resourceId ?? logical.id}' must resolve to exactly one carrier item.`,
          { target: logical.resourceId },
        ),
      );
      continue;
    }
    const components = outgoing(graph, carriers[0].id, 'uses_component')
      .map((edge) => nodeById(graph, edge.to))
      .filter((node): node is AssetNode => node !== undefined);
    if (components.length !== 1 || components[0]?.resourceId !== 'minecraft:item_model') {
      diagnostics.push(
        diagnostic(
          'visual.binding.item_model_component',
          'error',
          `Logical item '${logical.resourceId ?? logical.id}' must use exactly one minecraft:item_model component.`,
          { target: logical.resourceId },
        ),
      );
      continue;
    }
    const definitions = outgoing(graph, components[0].id, 'resolves_to')
      .map((edge) => nodeById(graph, edge.to))
      .filter((node): node is AssetNode => node?.kind === 'item_definition');
    if (definitions.length !== 1) {
      diagnostics.push(
        diagnostic(
          'visual.binding.item_definition',
          'error',
          `The minecraft:item_model binding for '${logical.resourceId ?? logical.id}' does not resolve to exactly one client item definition.`,
          { target: logical.resourceId },
        ),
      );
    }
    const expected = components[0].metadata?.value;
    if (typeof expected === 'string' && definitions[0]?.resourceId !== expected) {
      diagnostics.push(
        diagnostic(
          'visual.binding.wrong_item_definition',
          'error',
          `The item component value '${expected}' does not match its client item definition.`,
          { target: logical.resourceId },
        ),
      );
    }
  }

  for (const definition of graph.nodes.filter(
    (node) => node.kind === 'item_definition' && node.generated,
  )) {
    if (outgoing(graph, definition.id, 'selects_model').length === 0) {
      diagnostics.push(
        diagnostic(
          'visual.graph.item_definition_without_model',
          'error',
          `Client item definition '${definition.resourceId ?? definition.id}' does not select a model.`,
          { target: definition.resourceId, path: definition.path },
        ),
      );
    }
  }

  for (const model of graph.nodes.filter((node) => node.kind === 'model' && node.generated)) {
    if (outgoing(graph, model.id, 'inherits_model').length !== 1) {
      diagnostics.push(
        diagnostic(
          'visual.graph.model_parent',
          'error',
          `Generated model '${model.resourceId ?? model.id}' must inherit exactly one model parent.`,
          { target: model.resourceId, path: model.path },
        ),
      );
    }
    if (outgoing(graph, model.id, 'uses_texture').length === 0) {
      diagnostics.push(
        diagnostic(
          'visual.graph.model_without_texture',
          'error',
          `Generated model '${model.resourceId ?? model.id}' does not reference a texture.`,
          { target: model.resourceId, path: model.path },
        ),
      );
    }
  }

  const logicalBindings = new Map<string, Set<string>>();
  for (const logical of graph.nodes.filter((node) => node.kind === 'logical_item')) {
    const identity = logical.resourceId ?? logical.id;
    const signatures = logicalBindings.get(identity) ?? new Set<string>();
    signatures.add(
      `${String(logical.metadata?.carrierItem ?? '')}\u0000${String(logical.metadata?.itemModel ?? '')}`,
    );
    logicalBindings.set(identity, signatures);
  }
  for (const [identity, signatures] of logicalBindings) {
    if (signatures.size > 1) {
      diagnostics.push(
        diagnostic(
          'visual.binding.conflicting_carrier',
          'error',
          `Logical item '${identity}' has conflicting carrier or minecraft:item_model bindings.`,
          { target: identity },
        ),
      );
    }
  }
  return diagnostics;
}

export function validateVisualAsset(
  input: unknown,
  compiled: CompiledItemAsset,
  graph: VisualAssetGraph,
  options: VisualValidationOptions = {},
): VisualValidationResult {
  const diagnostics = [
    ...validateModelSpec(input),
    ...validateCompiledItemAsset(compiled, options),
    ...validateAssetGraph(graph),
  ];
  const graphPaths = new Set(
    graph.nodes.map((node) => node.path).filter((path): path is string => path !== undefined),
  );
  for (const file of compiled.files) {
    if (!graphPaths.has(file.path)) {
      diagnostics.push(
        diagnostic(
          'visual.graph.unrepresented_output',
          'error',
          `Compiled output '${file.path}' is missing from the asset graph.`,
          { target: compiled.spec.id, path: file.path },
        ),
      );
    }
  }
  return {
    ok: !diagnostics.some((entry) => entry.severity === 'error'),
    diagnostics,
    filesChecked: compiled.files.length,
    graphNodesChecked: graph.nodes.length,
  };
}

export function formatVisualDiagnostic(entry: VisualDiagnostic): string {
  const target = entry.target ?? '<visual asset>';
  const semantic = [
    entry.partId === undefined ? undefined : `part ${entry.partId}`,
    entry.materialId === undefined ? undefined : `material ${entry.materialId}`,
    entry.displayContext === undefined ? undefined : `display.${entry.displayContext}`,
    entry.reviewProfile === undefined ? undefined : `profile ${entry.reviewProfile}`,
    entry.reviewView === undefined ? undefined : `view ${entry.reviewView}`,
    entry.reviewMetric === undefined ? undefined : `metric ${entry.reviewMetric}`,
  ].filter((value): value is string => value !== undefined);
  return `${target}${semantic.length === 0 ? '' : ` / ${semantic.join(' / ')}`}\n${entry.message}${
    entry.suggestedFix === undefined ? '' : `\n${entry.suggestedFix}`
  }`;
}

export const MODEL_FACE_ORDER: readonly ModelFace[] = [
  'down',
  'up',
  'north',
  'south',
  'west',
  'east',
];
