import type { z } from 'zod';

import { ProviderError, type ProviderErrorCode } from './provider';

/*
 * HTTP for provider adapters: typed errors (TEST_PLAN §4.5), bounded retries with exponential
 * backoff, and Zod validation of every JSON response (provider responses are untrusted input).
 */

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  fetch?: FetchFn;
  /** Waits between retries (injectable so tests run instantly). */
  sleep?: (ms: number) => Promise<void>;
  /** Retries after the first attempt (default 3). */
  maxRetries?: number;
}

export interface SendOptions {
  /**
   * Safe to repeat: network errors and 5xx responses are retried. Rate limiting (429) is always
   * retried because the provider did not process the request.
   */
  idempotent: boolean;
  /** Non-2xx statuses the caller handles itself (e.g. Google's 308 "resume incomplete"). */
  accept?: readonly number[];
}

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;

/** Google APIs answer some rate limiting with 403 and one of these reasons. */
const RATE_LIMIT_REASONS = /"reason"\s*:\s*"(rateLimitExceeded|userRateLimitExceeded)"/;

/** True for a 429, or a 403 whose body says it is rate limiting. Consumes nothing on a clone. */
async function isRateLimited(response: Response): Promise<boolean> {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  try {
    return RATE_LIMIT_REASONS.test((await response.clone().text()).slice(0, 10_000));
  } catch {
    return false;
  }
}

/** Maps an unsuccessful status to a typed error code. */
export function statusToCode(status: number): ProviderErrorCode {
  if (status === 401) return 'AUTH_REQUIRED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409 || status === 412) return 'CONFLICT';
  if (status === 429) return 'RATE_LIMITED';
  return 'UNAVAILABLE';
}

function retryAfterMs(response: Response, attempt: number): number {
  const header = response.headers.get('retry-after');
  const seconds = header === null ? NaN : Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_DELAY_MS);
  return Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
}

export class HttpClient {
  private readonly fetchFn: FetchFn;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(options: HttpClientOptions = {}) {
    this.fetchFn = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRetries = options.maxRetries ?? 3;
  }

  /** Sends a request; resolves only with a 2xx response, otherwise throws ProviderError. */
  async send(
    url: string,
    init: RequestInit,
    { idempotent, accept = [] }: SendOptions,
  ): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const canRetry = attempt < this.maxRetries;
      let response: Response;
      try {
        // Redirects fail by default; a caller may opt in (Google's 308 "resume incomplete").
        response = await this.fetchFn(url, { redirect: 'error', ...init });
      } catch {
        if (idempotent && canRetry) {
          await this.sleep(Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS));
          continue;
        }
        throw new ProviderError('NETWORK');
      }
      if (response.ok || accept.includes(response.status)) return response;
      const rateLimited = await isRateLimited(response);
      const retryable = rateLimited || (idempotent && response.status >= 500);
      if (retryable && canRetry) {
        await response.body?.cancel();
        await this.sleep(retryAfterMs(response, attempt));
        continue;
      }
      await response.body?.cancel();
      throw new ProviderError(
        rateLimited ? 'RATE_LIMITED' : statusToCode(response.status),
        `HTTP ${response.status}`,
        response.status,
      );
    }
  }

  /** Waits the backoff delay for the given retry attempt (0-based). */
  backoff(attempt: number): Promise<void> {
    return this.sleep(Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS));
  }

  /** Sends a request and validates its JSON body. */
  async json<T>(
    url: string,
    init: RequestInit,
    options: SendOptions,
    schema: z.ZodType<T>,
  ): Promise<T> {
    return parseJson(await this.send(url, init, options), schema);
  }
}

export async function parseJson<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new ProviderError('INVALID_RESPONSE', 'Response is not JSON');
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new ProviderError('INVALID_RESPONSE', 'Unexpected response shape');
  return parsed.data;
}

/** Reads a response body with a hard size limit (never buffers more than `limit` bytes). */
export async function readBytes(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw new ProviderError('INVALID_RESPONSE', 'File is too large');
  }
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) {
        await reader.cancel();
        throw new ProviderError('INVALID_RESPONSE', 'File is too large');
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError('NETWORK');
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** OAuth session used by the provider adapters; the app supplies the implementation. */
export interface OAuthSession {
  isSignedIn(): boolean;
  /** Interactive sign-in. Throws ProviderError('CANCELLED') when the user aborts. */
  signIn(): Promise<void>;
  /** A valid access token (refreshing silently if possible), else ProviderError('AUTH_REQUIRED'). */
  getAccessToken(): Promise<string>;
  /** Forgets tokens on this device. */
  signOut(): Promise<void>;
  /**
   * Loads what `signIn` needs (e.g. a sign-in library), so `signIn` can open its window straight
   * from the user's click without being blocked as a popup.
   */
  prepare?(): Promise<void>;
}

/**
 * Runs an authorized operation. When the provider rejects the token (401), the session is
 * forgotten so the UI shows "connect again" instead of retrying with a dead token.
 */
export async function withSession<T>(
  session: OAuthSession,
  operation: (token: string) => Promise<T>,
): Promise<T> {
  if (!session.isSignedIn()) throw new ProviderError('AUTH_REQUIRED');
  try {
    return await operation(await session.getAccessToken());
  } catch (err) {
    if (err instanceof ProviderError && err.code === 'AUTH_REQUIRED') await session.signOut();
    throw err;
  }
}
