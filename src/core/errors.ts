export type PackwrightErrorCode =
  | 'invalid_argument'
  | 'invalid_workspace'
  | 'unsafe_path'
  | 'not_found'
  | 'already_exists'
  | 'not_a_datapack'
  | 'read_only'
  | 'unsupported_resource'
  | 'invalid_resource_id'
  | 'invalid_content'
  | 'size_limit'
  | 'scan_limit'
  | 'precondition_required'
  | 'precondition_failed'
  | 'confirmation_required'
  | 'validation_failed'
  | 'cancelled';

export class PackwrightError extends Error {
  readonly code: PackwrightErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: PackwrightErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'PackwrightError';
    this.code = code;
    this.details = details;
  }
}

export function isPackwrightError(value: unknown): value is PackwrightError {
  return value instanceof PackwrightError;
}
