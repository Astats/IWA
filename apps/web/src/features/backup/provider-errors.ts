import type { ProviderError, ProviderErrorCode } from '@budget/backup';

const KEYS: Record<ProviderErrorCode, string> = {
  AUTH_REQUIRED: 'backup.cloud.errors.authRequired',
  CANCELLED: 'backup.cloud.errors.cancelled',
  FORBIDDEN: 'backup.cloud.errors.forbidden',
  NOT_FOUND: 'backup.cloud.errors.notFound',
  CONFLICT: 'backup.cloud.errors.conflict',
  RATE_LIMITED: 'backup.cloud.errors.rateLimited',
  UNAVAILABLE: 'backup.cloud.errors.unavailable',
  NETWORK: 'backup.cloud.errors.network',
  INVALID_RESPONSE: 'backup.cloud.errors.unavailable',
  NOT_CONFIGURED: 'backup.cloud.errors.notConfigured',
};

/** Translated, generic message for a provider failure (no provider details shown; A10). */
export function providerErrorKey(err: ProviderError): string {
  return KEYS[err.code];
}
