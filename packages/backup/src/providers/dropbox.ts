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
 * Dropbox HTTP API v2 in the app's App folder (BUILD_PLAN 3.4). With "App folder" access, the
 * path "" is the app folder itself, so the app cannot see anything else in the user's Dropbox.
 */

export const DROPBOX_API = 'https://api.dropboxapi.com';
export const DROPBOX_CONTENT = 'https://content.dropboxapi.com';
/** Scopes requested at sign-in: list, read and write files in the app folder (SEC-W13). */
export const DROPBOX_SCOPES = [
  'files.metadata.read',
  'files.content.read',
  'files.content.write',
] as const;
const MAX_LIST_PAGES = 50;

const fileSchema = z.object({
  '.tag': z.literal('file'),
  id: z.string().min(1),
  name: z.string(),
  size: z.number().int().min(0),
  server_modified: z.string(),
});
type DropboxFile = z.infer<typeof fileSchema>;

const listSchema = z.object({
  entries: z.array(z.unknown()),
  cursor: z.string().min(1).max(10_000),
  has_more: z.boolean(),
});

/** Endpoint-specific errors come back as 409 with an `error_summary` (Dropbox docs). */
const errorSchema = z.object({ error_summary: z.string().max(1000) });

function toCandidate(file: DropboxFile) {
  return { id: file.id, name: file.name, size: file.size, createdAt: file.server_modified };
}

function toRemote(file: unknown): RemoteBackup {
  const parsed = fileSchema.safeParse({ '.tag': 'file', ...(file as object) });
  const remote = parsed.success ? remoteBackupSchema.safeParse(toCandidate(parsed.data)) : null;
  if (!remote?.success) throw new ProviderError('INVALID_RESPONSE', 'Unexpected file metadata');
  return remote.data;
}

/**
 * `Dropbox-API-Arg` must be HTTP-header safe: JSON with every non-ASCII character escaped
 * (Dropbox docs). Backup names are ASCII, ids are opaque; escape anyway.
 */
function apiArg(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export class DropboxProvider implements BackupProvider {
  readonly id = 'dropbox' as const;
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
      let page = await this.rpc(
        token,
        '/2/files/list_folder',
        { path: '', limit: 200 },
        listSchema,
      );
      for (let n = 1; ; n++) {
        for (const raw of page.entries) {
          const file = fileSchema.safeParse(raw);
          if (file.success) items.push(toCandidate(file.data));
        }
        if (!page.has_more || n >= MAX_LIST_PAGES) break;
        page = await this.rpc(
          token,
          '/2/files/list_folder/continue',
          { cursor: page.cursor },
          listSchema,
        );
      }
      return normalizeListing(items);
    });
  }

  upload(name: string, bytes: Uint8Array): Promise<RemoteBackup> {
    if (!BACKUP_NAME_PATTERN.test(name)) throw new RangeError('Invalid backup file name');
    return withSession(this.session, async (token) => {
      // Backups are at most 100 MB, below Dropbox's 150 MB single-request limit; one request is
      // atomic, so an interrupted upload never leaves a partial file.
      const response = await this.http.send(
        `${DROPBOX_CONTENT}/2/files/upload`,
        {
          method: 'POST',
          headers: {
            ...bearer(token),
            'Content-Type': 'application/octet-stream',
            'Dropbox-API-Arg': apiArg({
              path: `/${name}`,
              mode: 'add',
              autorename: false,
              mute: true,
              strict_conflict: true,
            }),
          },
          body: new Uint8Array(bytes),
        },
        { idempotent: false, accept: [409] },
      );
      return toRemote(await this.checked(response, z.unknown()));
    });
  }

  download(id: string): Promise<Uint8Array> {
    return withSession(this.session, async (token) => {
      const response = await this.http.send(
        `${DROPBOX_CONTENT}/2/files/download`,
        {
          method: 'POST',
          headers: { ...bearer(token), 'Dropbox-API-Arg': apiArg({ path: id }) },
        },
        { idempotent: true, accept: [409] },
      );
      if (response.status === 409) await this.checked(response, z.never());
      // Metadata arrives in a header; check it before reading the body.
      let raw: unknown = null;
      try {
        raw = JSON.parse(response.headers.get('dropbox-api-result') ?? 'null');
      } catch {
        raw = null;
      }
      const meta = fileSchema.safeParse({ '.tag': 'file', ...(raw as object | null) });
      const problem = !meta.success
        ? new ProviderError('INVALID_RESPONSE')
        : !BACKUP_NAME_PATTERN.test(meta.data.name)
          ? new ProviderError('NOT_FOUND') // only backup files are ever read
          : meta.data.size > MAX_BACKUP_FILE_BYTES
            ? new ProviderError('INVALID_RESPONSE')
            : null;
      if (problem) {
        await response.body?.cancel();
        throw problem;
      }
      return readBytes(response, MAX_BACKUP_FILE_BYTES);
    });
  }

  delete(id: string): Promise<void> {
    return withSession(this.session, async (token) => {
      await this.rpc(token, '/2/files/delete_v2', { path: id }, z.unknown());
    });
  }

  /** RPC endpoint on api.dropboxapi.com (JSON in, JSON out). */
  private async rpc<T>(token: string, path: string, body: unknown, schema: z.ZodType<T>) {
    const response = await this.http.send(
      `${DROPBOX_API}${path}`,
      {
        method: 'POST',
        headers: { ...bearer(token), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      // Listing and deleting by id are safe to repeat.
      { idempotent: true, accept: [409] },
    );
    return this.checked(response, schema);
  }

  /** Maps Dropbox's 409 endpoint errors to typed errors; validates a successful body. */
  private async checked<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
    if (response.status !== 409) return parseJson(response, schema);
    const { error_summary: summary } = await parseJson(response, errorSchema);
    if (/(^|\/)not_found(\/|$)|^path_lookup\/not_found/.test(summary)) {
      throw new ProviderError('NOT_FOUND');
    }
    if (/conflict/.test(summary)) throw new ProviderError('CONFLICT');
    if (/insufficient_space|too_many_write_operations/.test(summary)) {
      throw new ProviderError('UNAVAILABLE', summary);
    }
    throw new ProviderError('UNAVAILABLE', 'Dropbox endpoint error');
  }
}
