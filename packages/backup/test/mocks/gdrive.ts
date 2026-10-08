import { http, HttpResponse, type HttpHandler } from 'msw/http';

/*
 * In-memory Google Drive appDataFolder for MSW (TEST_PLAN §4.5): list with paging, multipart and
 * resumable uploads (308 + Range), metadata, alt=media downloads and deletes. Enforces the token.
 */

export const API = 'https://www.googleapis.com';

interface StoredFile {
  id: string;
  name: string;
  bytes: Uint8Array;
  createdTime: string;
  parents: string[];
}

interface Session {
  name: string;
  total: number;
  received: Uint8Array[];
  next: number;
}

export interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | null;
  contentRange: string | null;
}

type Failure = { match: (req: Request) => boolean; response: () => Response };

function concat(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Splits a multipart/related body into its JSON metadata and media part. */
function parseMultipart(body: Uint8Array, boundary: string) {
  // One char per byte (TextDecoder('latin1') is windows-1252 and would alter bytes 0x80-0x9f).
  const text = Array.from(body, (b) => String.fromCharCode(b)).join('');
  const parts = text.split(`--${boundary}`).slice(1, -1);
  const [meta, media] = parts.map((p) => p.slice(p.indexOf('\r\n\r\n') + 4, -2));
  return {
    metadata: JSON.parse(meta ?? '{}') as { name?: string; parents?: string[] },
    media: Uint8Array.from(media ?? '', (c) => c.charCodeAt(0)),
  };
}

export class FakeDrive {
  readonly files = new Map<string, StoredFile>();
  readonly sessions = new Map<string, Session>();
  readonly requests: RecordedRequest[] = [];
  pageSize = 100;
  token = 'test-access-token';
  /** Chunks that are stored but whose response is lost (client sees a network error). */
  loseChunkResponses = 0;
  private failures: Failure[] = [];
  private nextId = 1;
  private clock = Date.parse('2026-03-01T00:00:00Z');

  seed(name: string, bytes: Uint8Array = new Uint8Array(8), parents = ['appDataFolder']) {
    const file: StoredFile = {
      id: `drive-${this.nextId++}`,
      name,
      bytes,
      createdTime: new Date((this.clock += 60_000)).toISOString(),
      parents,
    };
    this.files.set(file.id, file);
    return file;
  }

  fail(match: (req: Request) => boolean, response: () => Response, times = 1): void {
    for (let i = 0; i < times; i++) this.failures.push({ match, response });
  }

  private resource(f: StoredFile, fields = 'id,name,size,createdTime') {
    const all: Record<string, unknown> = {
      id: f.id,
      name: f.name,
      size: String(f.bytes.length),
      createdTime: f.createdTime,
    };
    return Object.fromEntries(fields.split(',').map((k) => [k, all[k]]));
  }

  handlers(): HttpHandler[] {
    return [
      http.all(`${API}/*`, async ({ request }) => {
        this.requests.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.get('authorization'),
          contentRange: request.headers.get('content-range'),
        });
        const index = this.failures.findIndex((f) => f.match(request));
        if (index >= 0) return this.failures.splice(index, 1)[0]!.response();
        if (request.headers.get('authorization') !== `Bearer ${this.token}`) {
          return HttpResponse.json(
            { error: { code: 401, message: 'Invalid Credentials' } },
            { status: 401 },
          );
        }
        const url = new URL(request.url);
        const q = url.searchParams;

        if (url.pathname === '/drive/v3/files' && request.method === 'GET') {
          if (q.get('spaces') !== 'appDataFolder') return HttpResponse.json({}, { status: 400 });
          const all = [...this.files.values()].filter((f) => f.parents.includes('appDataFolder'));
          const start = Number(q.get('pageToken') ?? 0);
          const next = start + this.pageSize;
          return HttpResponse.json({
            files: all.slice(start, next).map((f) => this.resource(f)),
            ...(next < all.length ? { nextPageToken: String(next) } : {}),
          });
        }

        if (url.pathname === '/upload/drive/v3/files' && request.method === 'POST') {
          if (q.get('uploadType') === 'multipart') {
            const boundary = /boundary=(.+)$/.exec(request.headers.get('content-type') ?? '')?.[1];
            if (!boundary) return HttpResponse.json({}, { status: 400 });
            const { metadata, media } = parseMultipart(
              new Uint8Array(await request.arrayBuffer()),
              boundary,
            );
            const file = this.seed(metadata.name ?? '', media, metadata.parents ?? []);
            return HttpResponse.json(this.resource(file, q.get('fields') ?? undefined));
          }
          if (q.get('uploadType') === 'resumable') {
            const metadata = (await request.json()) as { name: string };
            const id = `upload-${this.nextId++}`;
            this.sessions.set(id, {
              name: metadata.name,
              total: Number(request.headers.get('x-upload-content-length')),
              received: [],
              next: 0,
            });
            return new HttpResponse(null, {
              status: 200,
              headers: {
                Location: `${API}/upload/drive/v3/files?uploadType=resumable&upload_id=${id}`,
              },
            });
          }
        }

        const uploadId = q.get('upload_id');
        if (url.pathname === '/upload/drive/v3/files' && uploadId) {
          const session = this.sessions.get(uploadId);
          if (!session) return HttpResponse.json({}, { status: 404 });
          if (request.method === 'DELETE') {
            this.sessions.delete(uploadId);
            return new HttpResponse(null, { status: 499 });
          }
          const range = request.headers.get('content-range') ?? '';
          const incomplete = () =>
            new HttpResponse(null, {
              status: 308,
              headers: session.next > 0 ? { Range: `bytes=0-${session.next - 1}` } : {},
            });
          if (/^bytes \*\/\d+$/.test(range)) return incomplete();
          const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
          if (!m) return HttpResponse.json({}, { status: 400 });
          const [from, to, total] = m.slice(1).map(Number) as [number, number, number];
          const body = new Uint8Array(await request.arrayBuffer());
          if (from !== session.next || body.length !== to - from + 1 || total !== session.total) {
            return HttpResponse.json({ error: { message: 'bad range' } }, { status: 400 });
          }
          const isLast = to + 1 === total;
          if (!isLast && body.length % (256 * 1024) !== 0)
            return HttpResponse.json({}, { status: 400 });
          session.received.push(body);
          session.next = to + 1;
          if (!isLast) {
            if (this.loseChunkResponses > 0) {
              this.loseChunkResponses--;
              return HttpResponse.error();
            }
            return incomplete();
          }
          this.sessions.delete(uploadId);
          const file = this.seed(session.name, concat(session.received, total));
          return HttpResponse.json(this.resource(file, q.get('fields') ?? undefined));
        }

        const fileMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
        const file = fileMatch ? this.files.get(decodeURIComponent(fileMatch[1]!)) : undefined;
        if (fileMatch && !file) return HttpResponse.json({ error: { code: 404 } }, { status: 404 });
        if (file && request.method === 'DELETE') {
          this.files.delete(file.id);
          return new HttpResponse(null, { status: 204 });
        }
        if (file && request.method === 'GET') {
          if (q.get('alt') === 'media') return new HttpResponse(new Uint8Array(file.bytes));
          return HttpResponse.json(this.resource(file, q.get('fields') ?? undefined));
        }
        return HttpResponse.json({ error: { message: 'unexpected request' } }, { status: 400 });
      }),
    ];
  }
}
