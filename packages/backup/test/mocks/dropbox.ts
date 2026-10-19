import { http, HttpResponse, type HttpHandler } from 'msw/http';

/*
 * In-memory Dropbox App folder for MSW (TEST_PLAN §4.5): list_folder (+continue), upload,
 * download (metadata in Dropbox-API-Result) and delete_v2, with Dropbox's 409 error shapes.
 */

export const API = 'https://api.dropboxapi.com';
export const CONTENT = 'https://content.dropboxapi.com';

interface StoredFile {
  id: string;
  name: string;
  bytes: Uint8Array;
  server_modified: string;
  folder?: boolean;
}

export interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | null;
  apiArg: string | null;
}

type Failure = { match: (req: Request) => boolean; response: () => Response };

export class FakeDropbox {
  readonly files = new Map<string, StoredFile>();
  readonly requests: RecordedRequest[] = [];
  pageSize = 200;
  token = 'test-access-token';
  private failures: Failure[] = [];
  private nextId = 1;
  private clock = Date.parse('2026-03-01T00:00:00Z');

  seed(name: string, bytes: Uint8Array = new Uint8Array(8), options: { folder?: boolean } = {}) {
    const file: StoredFile = {
      id: `id:dbx${this.nextId++}`,
      name,
      bytes,
      // Dropbox timestamps have no fractional seconds.
      server_modified: new Date((this.clock += 60_000)).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      ...(options.folder ? { folder: true } : {}),
    };
    this.files.set(file.id, file);
    return file;
  }

  fail(match: (req: Request) => boolean, response: () => Response, times = 1): void {
    for (let i = 0; i < times; i++) this.failures.push({ match, response });
  }

  private metadata(f: StoredFile) {
    return f.folder
      ? { '.tag': 'folder', id: f.id, name: f.name, path_lower: `/${f.name.toLowerCase()}` }
      : {
          '.tag': 'file',
          id: f.id,
          name: f.name,
          size: f.bytes.length,
          server_modified: f.server_modified,
          client_modified: f.server_modified,
          path_lower: `/${f.name.toLowerCase()}`,
        };
  }

  private conflict(summary: string) {
    return HttpResponse.json(
      { error_summary: summary, error: { '.tag': 'path' } },
      { status: 409 },
    );
  }

  private find(path: string): StoredFile | undefined {
    return path.startsWith('id:')
      ? this.files.get(path)
      : [...this.files.values()].find((f) => `/${f.name}` === path);
  }

  handlers(): HttpHandler[] {
    const guard = (request: Request) => {
      this.requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.get('authorization'),
        apiArg: request.headers.get('dropbox-api-arg'),
      });
      const index = this.failures.findIndex((f) => f.match(request));
      if (index >= 0) return this.failures.splice(index, 1)[0]!.response();
      if (request.headers.get('authorization') !== `Bearer ${this.token}`) {
        return HttpResponse.json({ error_summary: 'expired_access_token/' }, { status: 401 });
      }
      return null;
    };

    return [
      http.post(`${API}/2/files/list_folder`, async ({ request }) => {
        const failure = guard(request);
        if (failure) return failure;
        const body = (await request.json()) as { path: string };
        if (body.path !== '') return this.conflict('path/not_found/');
        return this.page(0);
      }),
      http.post(`${API}/2/files/list_folder/continue`, async ({ request }) => {
        const failure = guard(request);
        if (failure) return failure;
        const { cursor } = (await request.json()) as { cursor: string };
        return this.page(Number(cursor.replace('cursor-', '')));
      }),
      http.post(`${API}/2/files/delete_v2`, async ({ request }) => {
        const failure = guard(request);
        if (failure) return failure;
        const { path } = (await request.json()) as { path: string };
        const file = this.find(path);
        if (!file) return this.conflict('path_lookup/not_found/');
        this.files.delete(file.id);
        return HttpResponse.json({ metadata: this.metadata(file) });
      }),
      http.post(`${CONTENT}/2/files/upload`, async ({ request }) => {
        const failure = guard(request);
        if (failure) return failure;
        const arg = JSON.parse(request.headers.get('dropbox-api-arg') ?? '{}') as {
          path: string;
          mode: string;
          strict_conflict: boolean;
        };
        if (arg.mode !== 'add' || !arg.strict_conflict)
          return HttpResponse.json({}, { status: 400 });
        if (this.find(arg.path)) return this.conflict('path/conflict/file/..');
        const file = this.seed(arg.path.slice(1), new Uint8Array(await request.arrayBuffer()));
        return HttpResponse.json(this.metadata(file));
      }),
      http.post(`${CONTENT}/2/files/download`, ({ request }) => {
        const failure = guard(request);
        if (failure) return failure;
        const { path } = JSON.parse(request.headers.get('dropbox-api-arg') ?? '{}') as {
          path: string;
        };
        const file = this.find(path);
        if (!file) return this.conflict('path/not_found/..');
        return new HttpResponse(new Uint8Array(file.bytes), {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Dropbox-API-Result': JSON.stringify(this.metadata(file)),
          },
        });
      }),
    ];
  }

  private page(start: number) {
    const all = [...this.files.values()];
    const end = start + this.pageSize;
    return HttpResponse.json({
      entries: all.slice(start, end).map((f) => this.metadata(f)),
      cursor: `cursor-${end}`,
      has_more: end < all.length,
    });
  }
}
