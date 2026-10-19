import { z } from 'zod';

import { MAX_BACKUP_FILE_BYTES } from '../format';
import {
  HttpClient,
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
 * Microsoft OneDrive via Microsoft Graph (BUILD_PLAN 3.2). Files live in the app folder
 * (/me/drive/special/approot), which the delegated scope Files.ReadWrite.AppFolder is limited to.
 */

export const GRAPH_ORIGIN = 'https://graph.microsoft.com';
const GRAPH = `${GRAPH_ORIGIN}/v1.0`;
const APP_ROOT = `${GRAPH}/me/drive/special/approot`;
/** Delegated permission requested at sign-in (minimal scope; SEC-W13). */
export const ONEDRIVE_SCOPES = ['Files.ReadWrite.AppFolder'] as const;

/** Above this size, uploads use an upload session (Graph's simple upload limit is 4 MB). */
export const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;
/** Upload session fragments must be multiples of 320 KiB; 10 × 320 KiB = 3.125 MiB. */
export const UPLOAD_CHUNK_BYTES = 10 * 320 * 1024;
const MAX_LIST_PAGES = 50;

const driveItemSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  size: z.number().int().min(0).optional(),
  createdDateTime: z.string().optional(),
  file: z.object({}).optional(),
});
type DriveItem = z.infer<typeof driveItemSchema>;

const listPageSchema = z.object({
  value: z.array(z.unknown()),
  '@odata.nextLink': z.url().optional(),
});

const uploadSessionSchema = z.object({ uploadUrl: z.url({ protocol: /^https$/ }) });
const sessionStatusSchema = z.object({ nextExpectedRanges: z.array(z.string()).optional() });
const downloadInfoSchema = driveItemSchema.extend({
  '@microsoft.graph.downloadUrl': z.url({ protocol: /^https$/ }),
});

function toRemote(item: DriveItem): RemoteBackup {
  const parsed = remoteBackupSchema.safeParse({
    id: item.id,
    name: item.name,
    size: item.size,
    createdAt: item.createdDateTime,
  });
  if (!parsed.success) throw new ProviderError('INVALID_RESPONSE', 'Unexpected drive item');
  return parsed.data;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export class OneDriveProvider implements BackupProvider {
  readonly id = 'onedrive' as const;
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

  connect(): Promise<void> {
    return this.session.signIn();
  }

  disconnect(): Promise<void> {
    return this.session.signOut();
  }

  list(): Promise<RemoteBackup[]> {
    return withSession(this.session, async (token) => {
      const items: unknown[] = [];
      let url: string | undefined =
        `${APP_ROOT}/children?$select=id,name,size,createdDateTime,file&$top=200`;
      for (let page = 0; url && page < MAX_LIST_PAGES; page++) {
        // Never send the token anywhere but Graph, even if a response says so.
        if (new URL(url).origin !== GRAPH_ORIGIN) throw new ProviderError('INVALID_RESPONSE');
        const body: z.infer<typeof listPageSchema> = await this.http.json(
          url,
          { headers: bearer(token) },
          { idempotent: true },
          listPageSchema,
        );
        for (const raw of body.value) {
          const item = driveItemSchema.safeParse(raw);
          if (item.success && item.data.file) {
            items.push({
              id: item.data.id,
              name: item.data.name,
              size: item.data.size,
              createdAt: item.data.createdDateTime,
            });
          }
        }
        url = body['@odata.nextLink'];
      }
      return normalizeListing(items);
    });
  }

  upload(name: string, bytes: Uint8Array): Promise<RemoteBackup> {
    if (!BACKUP_NAME_PATTERN.test(name)) throw new RangeError('Invalid backup file name');
    return withSession(this.session, (token) =>
      bytes.length <= SIMPLE_UPLOAD_LIMIT
        ? this.simpleUpload(token, name, bytes)
        : this.sessionUpload(token, name, bytes),
    );
  }

  download(id: string): Promise<Uint8Array> {
    return withSession(this.session, async (token) => {
      const info = await this.http.json(
        `${GRAPH}/me/drive/items/${encodeURIComponent(id)}`,
        { headers: bearer(token) },
        { idempotent: true },
        downloadInfoSchema,
      );
      // Only backup files are ever read, and their size is checked before downloading.
      if (!BACKUP_NAME_PATTERN.test(info.name)) throw new ProviderError('NOT_FOUND');
      if ((info.size ?? 0) > MAX_BACKUP_FILE_BYTES) throw new ProviderError('INVALID_RESPONSE');
      // The pre-authenticated URL needs (and must not get) the bearer token.
      const response = await this.http.send(
        info['@microsoft.graph.downloadUrl'],
        {},
        { idempotent: true },
      );
      return readBytes(response, MAX_BACKUP_FILE_BYTES);
    });
  }

  delete(id: string): Promise<void> {
    return withSession(this.session, async (token) => {
      await this.http.send(
        `${GRAPH}/me/drive/items/${encodeURIComponent(id)}`,
        { method: 'DELETE', headers: bearer(token) },
        { idempotent: true },
      );
    });
  }

  private async simpleUpload(token: string, name: string, bytes: Uint8Array) {
    const item = await this.http.json(
      `${APP_ROOT}:/${encodeURIComponent(name)}:/content?@microsoft.graph.conflictBehavior=fail`,
      {
        method: 'PUT',
        headers: { ...bearer(token), 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(bytes),
      },
      // A repeated PUT after an unseen success would fail with 409, never duplicate the file.
      { idempotent: false },
      driveItemSchema,
    );
    return toRemote(item);
  }

  /**
   * Resumable upload: the file only appears once the last fragment is accepted, and a failed
   * upload cancels the session, so an interrupted upload never leaves a partial backup behind.
   */
  private async sessionUpload(token: string, name: string, bytes: Uint8Array) {
    const { uploadUrl } = await this.http.json(
      `${APP_ROOT}:/${encodeURIComponent(name)}:/createUploadSession`,
      {
        method: 'POST',
        headers: { ...bearer(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'fail' } }),
      },
      { idempotent: false },
      uploadSessionSchema,
    );
    try {
      let offset = 0;
      // Bounded: a session that never makes progress fails instead of looping forever.
      const maxRequests = 4 * Math.ceil(bytes.length / UPLOAD_CHUNK_BYTES) + 4;
      for (let request = 0; ; request++) {
        if (request >= maxRequests) throw new ProviderError('UNAVAILABLE', 'Upload stalled');
        const end = Math.min(offset + UPLOAD_CHUNK_BYTES, bytes.length);
        let response: Response;
        try {
          // No Authorization header: the upload URL is pre-authenticated (Graph docs).
          response = await this.http.send(
            uploadUrl,
            {
              method: 'PUT',
              headers: { 'Content-Range': `bytes ${offset}-${end - 1}/${bytes.length}` },
              body: bytes.slice(offset, end),
            },
            { idempotent: true },
          );
        } catch (err) {
          // 416: the fragment was already received; ask the session where to continue.
          if (!(err instanceof ProviderError) || err.status !== 416) throw err;
          offset = await this.nextExpectedOffset(uploadUrl);
          continue;
        }
        if (response.status === 200 || response.status === 201) {
          return toRemote(driveItemSchema.parse(await response.json()));
        }
        await response.body?.cancel();
        offset = end;
        if (offset >= bytes.length) offset = await this.nextExpectedOffset(uploadUrl);
      }
    } catch (err) {
      await this.http
        .send(uploadUrl, { method: 'DELETE' }, { idempotent: true })
        .catch(() => undefined);
      if (err instanceof z.ZodError) throw new ProviderError('INVALID_RESPONSE');
      throw err;
    }
  }

  private async nextExpectedOffset(uploadUrl: string): Promise<number> {
    const status = await this.http.json(uploadUrl, {}, { idempotent: true }, sessionStatusSchema);
    const start = Number(/^(\d+)-/.exec(status.nextExpectedRanges?.[0] ?? '')?.[1]);
    if (!Number.isInteger(start)) throw new ProviderError('INVALID_RESPONSE');
    return start;
  }
}
