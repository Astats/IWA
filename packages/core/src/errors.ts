export type DomainErrorCode =
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'CATEGORY_NOT_FOUND'
  | 'CATEGORY_KIND_MISMATCH'
  | 'CATEGORY_IN_USE'
  | 'DUPLICATE_CATEGORY_NAME'
  | 'DUPLICATE_ID';

/** A business-rule violation. `message` is for developers; UIs translate `code`. */
export class DomainError extends Error {
  override readonly name = 'DomainError';

  constructor(
    readonly code: DomainErrorCode,
    message: string = code,
  ) {
    super(message);
  }
}

export function isDomainError(err: unknown, code?: DomainErrorCode): err is DomainError {
  return err instanceof DomainError && (code === undefined || err.code === code);
}
