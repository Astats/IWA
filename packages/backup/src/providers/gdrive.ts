import { z } from 'zod';

import { MAX_BACKUP_FILE_BYTES } from '../format';
import {
  HttpClient,
  parseJson,
  readBytes,
  withSession,
  type HttpClientOptions,
  type OAuthSession,
} from '../http';
import {
  BACKUP_NAME_PATTERN,
  ProviderError,
  normalizeListing,
  remoteBackupSchema,
  type BackupProvider,
  type RemoteBackup,
} from '../provider';

/*
 * Google Drive API v3 in the hidden application data folder (BUILD_PLAN 3.3). The scope
 * drive.appdata only reaches files this app created there.
 */

export const GOOGLE_API_ORIGIN = 'https://www.googleapis.com';
const FILES = `${GOOGLE_API_ORIGIN}/drive/v3/files`;
const UPLOAD = `${GOOGLE_API_ORIGIN}/upload/drive/v3/files`;
const FIELDS = 'id,name,size,createdTime';
/** OAuth scope requested at sign-in (minimal scope; SEC-W13). */
export const GDRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.appdata'] as const;

/** Up to this size a single multipart request is used (Drive's documented limit is 5 MB). */
export const MULTIPART_LIMIT = 5 * 1024 * 1024;
/** Resumable chunks must be multiples of 256 KiB; 16 × 256 KiB = 4 MiB. */
export const GDRIVE_CHUNK_BYTES = 16 * 256 * 1024;
const MAX_LIST_PAGES = 50;
/** Consecutive failed chunk attempts before the upload is abandoned. */
const MAX_CHUNK_FAILURES = 3;

const fileSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  /** int64 as a decimal string. */
  size: z
    .string()
    .regex(/^\d{1,15}$/)
    .optional(),
  createdTime: z.string().optional(),
});
type DriveFile = z.infer<typeof fileSchema>;

const listSchema = z.object({
  files: z.array(z.unknown()),
  nextPageToken: z.string().min(1).max(4096).optional(),
});

function toCandidate(file: DriveFile) {
  return {
    id: file.id,
    name: file.name,
    size: file.size === undefined ? undefined : Number(file.size),
    createdAt: file.createdTime,
  };
}

function toRemote(file: DriveFile): RemoteBackup {
  const parsed = remoteBackupSchema.safeParse(toCandidate(file));
  if (!parsed.success) throw new ProviderError('INVALID_RESPONSE', 'Unexpected file resource');
  return parsed.data;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Random multipart boundary (Web Crypto, never Math.random). */
function boundary(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `budget-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export class GoogleDriveProvider implements BackupProvider {
  readonly id = 'gdrive' as const;
  private readonly http: HttpClient;

  constructor(
    private readonly session: OAuthSession,
    options: HttpClientOptions = {},
  ) {
    this.http = new HttpClient(options);
  }

  isConnected(): boolean {
    return this.session.isSignedIn();
  }

  prepare(): Promise<void> {
    return this.session.prepare?.() ?? Promise.resolve();
  }

  connect(): Promise<void> {
    return this.session.signIn();
  }

  disconnect(): Promise<void> {
    return this.session.signOut();
  }

  list(): Promise<RemoteBackup[]> {
    return withSession(this.session, async (token) => {
      const items: unknown[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const params = new URLSearchParams({
          spaces: 'appDataFolder',
          fields: `nextPageToken,files(${FIELDS})`,
          pageSize: '100',
          orderBy: 'createdTime desc',
        });
        if (pageToken) params.set('pageToken', pageToken);
        const body = await this.http.json(
          `${FILES}?${params.toString()}`,
          { headers: bearer(token) },
          { idempotent: true },
          listSchema,
        );
        for (const raw of body.files) {
          const file = fileSchema.safeParse(raw);
          if (file.success) items.push(toCandidate(file.data));
        }
        pageToken = body.nextPageToken;
        if (!pageToken) break;
      }
      return normalizeListing(items);
    });
  }

  upload(name: string, bytes: Uint8Array): Promise<RemoteBackup> {
    if (!BACKUP_NAME_PATTERN.test(name)) throw new RangeError('Invalid backup file name');
    return withSession(this.session, (token) =>
      bytes.length <= MULTIPART_LIMIT
        ? this.multipartUpload(token, name, bytes)
        : this.resumableUpload(token, name, bytes),
    );
  }

  download(id: string): Promise<Uint8Array> {
    return withSession(this.session, async (token) => {
      const url = `${FILES}/${encodeURIComponent(id)}`;
      const meta = await this.http.json(
        `${url}?fields=${FIELDS}`,
        { headers: bearer(token) },
        { idempotent: true },
        fileSchema,
      );
      // Only backup files are ever read, and their size is checked before downloading.
      if (!BACKUP_NAME_PATTERN.test(meta.name)) throw new ProviderError('NOT_FOUND');
      if (Number(meta.size ?? 0) > MAX_BACKUP_FILE_BYTES) {
        throw new ProviderError('INVALID_RESPONSE');
      }
      const response = await this.http.send(
        `${url}?alt=media`,
        { headers: bearer(token) },
        { idempotent: true },
      );
      return readBytes(response, MAX_BACKUP_FILE_BYTES);
    });
  }

  delete(id: string): Promise<void> {
    return withSession(this.session, async (token) => {
      await this.http.send(
        `${FILES}/${encodeURIComponent(id)}`,
        { method: 'DELETE', headers: bearer(token) },
        { idempotent: true },
      );
    });
  }

  private async multipartUpload(token: string, name: string, bytes: Uint8Array) {
    const b = boundary();
    const enc = new TextEncoder();
    const head = enc.encode(
      `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${JSON.stringify({ name, parents: ['appDataFolder'] })}\r\n` +
        `--${b}\r\nContent-Type: application/octet-stream\r\n\r\n`,
    );
    const tail = enc.encode(`\r\n--${b}--\r\n`);
    const body = new Uint8Array(head.length + bytes.length + tail.length);
    body.set(head, 0);
    body.set(bytes, head.length);
    body.set(tail, head.length + bytes.length);
    const file = await this.http.json(
      `${UPLOAD}?uploadType=multipart&fields=${FIELDS}`,
      {
        method: 'POST',
        headers: { ...bearer(token), 'Content-Type': `multipart/related; boundary=${b}` },
        body,
      },
      // Not repeatable: a retry after an unseen success would create a second file.
      { idempotent: false },
      fileSchema,
    );
    return toRemote(file);
  }

  /**
   * Resumable upload: the file only exists once the last chunk is accepted; a failed upload
   * cancels the session, so an interrupted upload never leaves a partial backup behind.
   */
  private async resumableUpload(token: string, name: string, bytes: Uint8Array) {
    const start = await this.http.send(
      `${UPLOAD}?uploadType=resumable&fields=${FIELDS}`,
      {
        method: 'POST',
        headers: {
          ...bearer(token),
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': 'application/octet-stream',
          'X-Upload-Content-Length': String(bytes.length),
        },
        body: JSON.stringify({ name, parents: ['appDataFolder'] }),
      },
      { idempotent: false },
    );
    await start.body?.cancel();
    const sessionUrl = start.headers.get('location');
    // The session URI receives the bearer token, so it must be Google's API origin.
    if (!sessionUrl || new URL(sessionUrl).origin !== GOOGLE_API_ORIGIN) {
      throw new ProviderError('INVALID_RESPONSE', 'Missing upload session');
    }
    try {
      let offset = 0;
      let failures = 0;
      const maxRequests = 4 * Math.ceil(bytes.length / GDRIVE_CHUNK_BYTES) + 4;
      for (let request = 0; ; request++) {
        if (request >= maxRequests) throw new ProviderError('UNAVAILABLE', 'Upload stalled');
        const end = Math.min(offset + GDRIVE_CHUNK_BYTES, bytes.length);
        let response: Response;
        try {
          response = await this.http.send(
            sessionUrl,
            {
              method: 'PUT',
              // A 308 without Location is not a redirect; with 'follow' fetch returns it as is.
              redirect: 'follow',
              headers: {
                ...bearer(token),
                'Content-Range': `bytes ${offset}-${end - 1}/${bytes.length}`,
              },
              body: bytes.slice(offset, end),
            },
            // Not blindly repeated: the chunk may have arrived even though the response did not.
            { idempotent: false, accept: [308] },
          );
        } catch (err) {
          // Interrupted or 5xx: back off, then ask the session how much it has (Drive docs).
          const transient =
            err instanceof ProviderError && (err.code === 'NETWORK' || err.code === 'UNAVAILABLE');
          if (!transient || ++failures > MAX_CHUNK_FAILURES) throw err;
          await this.http.backoff(failures - 1);
          offset = await this.uploadedBytes(token, sessionUrl, bytes.length);
          continue;
        }
        failures = 0;
        if (response.status !== 308) return toRemote(await parseJson(response, fileSchema));
        await response.body?.cancel();
        offset = rangeEnd(response);
      }
    } catch (err) {
      await this.http
        .send(
          sessionUrl,
          { method: 'DELETE', headers: bearer(token) },
          { idempotent: true, accept: [499] },
        )
        .catch(() => undefined);
      throw err;
    }
  }

  /** Asks a resumable session how many bytes it has (`Content-Range: bytes * /total`). */
  private async uploadedBytes(token: string, sessionUrl: string, total: number): Promise<number> {
    const response = await this.http.send(
      sessionUrl,
      {
        method: 'PUT',
        redirect: 'follow',
        headers: { ...bearer(token), 'Content-Range': `bytes */${total}` },
      },
      { idempotent: true, accept: [308] },
    );
    await response.body?.cancel();
    if (response.status !== 308) throw new ProviderError('INVALID_RESPONSE');
    return rangeEnd(response);
  }
}

/** Next offset from a 308 response's `Range: bytes=0-N` header (none → nothing stored yet). */
function rangeEnd(response: Response): number {
  const range = response.headers.get('range');
  if (range === null) return 0;
  const match = /^bytes=0-(\d+)$/.exec(range);
  if (!match) throw new ProviderError('INVALID_RESPONSE');
  return Number(match[1]) + 1;
}
