import type { ScanResult } from './scanner.js';
import type { Workspace } from './workspace.js';

export type MinecraftVersion = '26.2';

export type PackFormat = readonly [major: number, minor: number];

export type VisualCapabilityStatus = 'native' | 'simulated' | 'replacement' | 'requires_mod';
export type VisualSupportLevel = 'full' | 'limited' | 'unsupported';
export type VisualCompilerSupport = 'full' | 'limited' | 'unsupported';

export type VisualTarget =
  | 'custom_item'
  | 'conditional_item_state'
  | 'existing_block_appearance'
  | 'new_block_identity'
  | 'furniture_static_prop'
  | 'armor_equipment'
  | 'painting_trim_variant'
  | 'existing_mob_texture'
  | 'existing_mob_geometry'
  | 'new_mob_pet'
  | 'skeletal_animated_creature'
  | 'projectile_spell_visual'
  | 'new_particle_type'
  | 'gui_font_sprite';

export interface VisualCapability {
  readonly target: VisualTarget;
  readonly status: VisualCapabilityStatus;
  /** What Minecraft 26.2 can represent for this target. */
  readonly support: VisualSupportLevel;
  /** What the currently shipped Packwright compiler can automate. */
  readonly compilerSupport: VisualCompilerSupport;
  readonly strategies: readonly string[];
  /** Whether the result has a distinct vanilla identity of the requested kind. */
  readonly nativeIdentity: boolean;
  /** Required plain-language disclosure for approximated or replacement targets. */
  readonly disclosure?: string | undefined;
  readonly limitation?: string | undefined;
}

export type VisualCapabilityProfile = Readonly<Record<VisualTarget, VisualCapability>>;

export type DiagnosticSeverity = 'error' | 'warning' | 'information' | 'hint';
export type DiagnosticAuthority = 'structural' | 'advisory' | 'authoritative';

export interface SourcePosition {
  line: number;
  character: number;
}

export interface SourceRange {
  start: SourcePosition;
  end: SourcePosition;
}

export interface Diagnostic {
  engine: 'packwright' | 'spyglass' | 'minecraft' | (string & {});
  authority: DiagnosticAuthority;
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  path?: string | undefined;
  range?: SourceRange | undefined;
  suggestedFix?: string | undefined;
}

export interface TextDiff {
  beforeSha256?: string | undefined;
  afterSha256?: string | undefined;
  unified: string;
  truncated: boolean;
}

export interface OperationResult<T = unknown> {
  ok: boolean;
  operation: string;
  changed: boolean;
  dryRun: boolean;
  path?: string | undefined;
  sha256?: string | undefined;
  previousSha256?: string | undefined;
  diff?: TextDiff | undefined;
  value?: T | undefined;
  diagnostics: Diagnostic[];
}

export interface BuildResult {
  ok: boolean;
  path?: string | undefined;
  size?: number | undefined;
  sha256?: string | undefined;
  entries: number;
  diagnostics: Diagnostic[];
  vanilla?: VanillaValidationSummary | undefined;
  truncated?: boolean | undefined;
}

export type GameTestStatus = 'passed' | 'failed' | 'setup_required' | 'cancelled' | 'timeout';

export interface GameTestCaseResult {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs?: number | undefined;
  message?: string | undefined;
}

export interface GameTestResult {
  ok: boolean;
  status: GameTestStatus;
  exitCode?: number | undefined;
  durationMs: number;
  reportPath?: string | undefined;
  tests: GameTestCaseResult[];
  diagnostics: Diagnostic[];
  stdout?: string | undefined;
  stderr?: string | undefined;
  truncated?: boolean | undefined;
}

export interface ResourceInventoryEntry {
  path: string;
  size: number;
  sha256: string;
  resourceType?: string | undefined;
  resourceId?: string | undefined;
}

export interface ValidationResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  filesScanned: number;
  bytesScanned: number;
  vanilla?: VanillaValidationSummary | undefined;
  truncated?: boolean | undefined;
}

export type VanillaValidationStatus = 'passed' | 'failed' | 'setup_required' | 'timeout';

export interface VanillaValidationSummary {
  status: VanillaValidationStatus;
  filesChecked: number;
  commandLinesChecked: number;
  macroLinesDeferred: number;
  durationMs: number;
}

export interface ValidationAdapterContext {
  readonly workspace: Workspace;
  readonly packPath: string;
  readonly scan: ScanResult;
}

export interface ValidationAdapter {
  readonly name: string;
  readonly authority?: DiagnosticAuthority | undefined;
  validate(
    packRoot: string,
    signal?: AbortSignal,
    context?: ValidationAdapterContext,
  ): Promise<readonly Diagnostic[]>;
}
