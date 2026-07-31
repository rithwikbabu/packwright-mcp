export type ItemPropertyKind = 'condition' | 'select' | 'range_dispatch';

type ParameterType = 'boolean' | 'nonnegative_integer' | 'positive_number';

interface PropertyDescriptor {
  readonly parameters: Readonly<Record<string, ParameterType>>;
  readonly selectValues?: ReadonlySet<string> | undefined;
}

const noParameters = (): PropertyDescriptor => Object.freeze({ parameters: Object.freeze({}) });

const CONDITION_PROPERTIES: Readonly<Record<string, PropertyDescriptor>> = Object.freeze({
  'minecraft:broken': noParameters(),
  'minecraft:bundle/has_selected_item': noParameters(),
  'minecraft:carried': noParameters(),
  'minecraft:damaged': noParameters(),
  'minecraft:extended_view': noParameters(),
  'minecraft:fishing_rod/cast': noParameters(),
  'minecraft:selected': noParameters(),
  'minecraft:using_item': noParameters(),
  'minecraft:view_entity': noParameters(),
  'minecraft:custom_model_data': Object.freeze({
    parameters: Object.freeze({ index: 'nonnegative_integer' }),
  }),
});

const SELECT_PROPERTIES: Readonly<Record<string, PropertyDescriptor>> = Object.freeze({
  'minecraft:charge_type': Object.freeze({
    parameters: Object.freeze({}),
    selectValues: new Set(['none', 'rocket', 'arrow']),
  }),
  'minecraft:display_context': Object.freeze({
    parameters: Object.freeze({}),
    selectValues: new Set([
      'none',
      'thirdperson_lefthand',
      'thirdperson_righthand',
      'firstperson_lefthand',
      'firstperson_righthand',
      'head',
      'gui',
      'ground',
      'fixed',
    ]),
  }),
  'minecraft:main_hand': Object.freeze({
    parameters: Object.freeze({}),
    selectValues: new Set(['left', 'right']),
  }),
  'minecraft:custom_model_data': Object.freeze({
    parameters: Object.freeze({ index: 'nonnegative_integer' }),
  }),
});

const RANGE_PROPERTIES: Readonly<Record<string, PropertyDescriptor>> = Object.freeze({
  'minecraft:bundle/fullness': noParameters(),
  'minecraft:cooldown': noParameters(),
  'minecraft:crossbow/pull': noParameters(),
  'minecraft:count': Object.freeze({
    parameters: Object.freeze({ normalize: 'boolean' }),
  }),
  'minecraft:damage': Object.freeze({
    parameters: Object.freeze({ normalize: 'boolean' }),
  }),
  'minecraft:custom_model_data': Object.freeze({
    parameters: Object.freeze({ index: 'nonnegative_integer' }),
  }),
  'minecraft:use_cycle': Object.freeze({
    parameters: Object.freeze({ period: 'positive_number' }),
  }),
  'minecraft:use_duration': Object.freeze({
    parameters: Object.freeze({ remaining: 'boolean' }),
  }),
});

const PROPERTIES: Readonly<Record<ItemPropertyKind, Readonly<Record<string, PropertyDescriptor>>>> =
  Object.freeze({
    condition: CONDITION_PROPERTIES,
    select: SELECT_PROPERTIES,
    range_dispatch: RANGE_PROPERTIES,
  });

function validParameter(value: unknown, type: ParameterType): boolean {
  switch (type) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'nonnegative_integer':
      return Number.isSafeInteger(value) && (value as number) >= 0;
    case 'positive_number':
      return typeof value === 'number' && Number.isFinite(value) && value > 0;
  }
}

/**
 * Validate the deliberately limited, version-pinned item-property subset that
 * Packwright v0.3 can compile and structurally prove. Unknown codecs fail
 * closed instead of being copied into a client item definition unchecked.
 */
export function validateItemProperty(
  kind: ItemPropertyKind,
  property: string,
  parameters: Readonly<Record<string, unknown>>,
): readonly string[] {
  const descriptor = PROPERTIES[kind][property];
  if (descriptor === undefined) {
    return [`Unsupported Minecraft 26.2 ${kind} item property '${property}'.`];
  }
  const issues: string[] = [];
  for (const [name, value] of Object.entries(parameters)) {
    const expected = descriptor.parameters[name];
    if (expected === undefined) {
      issues.push(`Property '${property}' does not accept parameter '${name}'.`);
    } else if (!validParameter(value, expected)) {
      issues.push(`Property '${property}' parameter '${name}' must be ${expected}.`);
    }
  }
  return issues;
}

export function validateSelectValues(
  property: string,
  values: readonly string[],
): readonly string[] {
  const selectValues = SELECT_PROPERTIES[property]?.selectValues;
  if (selectValues === undefined) return [];
  return values
    .filter((value) => !selectValues.has(value))
    .map((value) => `Property '${property}' cannot match value '${value}'.`);
}

export function inlineItemPropertyParameters(
  value: Readonly<Record<string, unknown>>,
  reserved: ReadonlySet<string>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !reserved.has(key)));
}
