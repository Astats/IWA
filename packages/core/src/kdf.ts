import './zod-config';

import { z } from 'zod';

/** Argon2id parameters (AD12). `memoryKiB` is in KiB. */
export interface KdfParams {
  algorithm: 'argon2id';
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

/** Production parameters: m = 64 MiB, t = 3, p = 1. */
export const PRODUCTION_KDF_PARAMS: KdfParams = {
  algorithm: 'argon2id',
  memoryKiB: 64 * 1024,
  iterations: 3,
  parallelism: 1,
};

/** Upper bounds that protect against a crafted header asking for absurd work (DoS). */
export const MAX_KDF_PARAMS: Omit<KdfParams, 'algorithm'> = {
  memoryKiB: 1024 * 1024,
  iterations: 16,
  parallelism: 8,
};

export const kdfParamsSchema = z.strictObject({
  algorithm: z.literal('argon2id'),
  memoryKiB: z.number().int().min(8).max(MAX_KDF_PARAMS.memoryKiB),
  iterations: z.number().int().min(1).max(MAX_KDF_PARAMS.iterations),
  parallelism: z.number().int().min(1).max(MAX_KDF_PARAMS.parallelism),
});

/** True when `params` are at least as strong as `minimum` in every dimension (downgrade guard). */
export function meetsMinimumKdf(params: KdfParams, minimum: KdfParams): boolean {
  return (
    params.memoryKiB >= minimum.memoryKiB &&
    params.iterations >= minimum.iterations &&
    params.parallelism >= minimum.parallelism
  );
}
