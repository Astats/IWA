import { http, HttpResponse, type HttpHandler } from 'msw/http';

/*
 * In-memory Microsoft Graph app folder for MSW (TEST_PLAN §4.5). Implements the endpoints the
 * OneDrive adapter uses, enforces the bearer token, and lets tests inject failures.
 */

export const GRAPH = 'https://graph.microsoft.com/v1.0';
export const UPLOAD_HOST = 'https://mock.up.1drv.com';
export const DOWNLOAD_HOST = 'https://mock.files.1drv.com';

interface StoredItem {
  id: string;
  name: string;
  bytes: Uint8Array;
  createdDateTime: string;
  folder?: boolean;
}

interface UploadSession {
  name: string;
  total: number | null;
  received: Uint8Array[];
  next: number;
}

type Failure = { match: (req: Request) => boolean; response: () => Response };

export interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | null;
  contentRange: string | null;
  bodyBytes: number;
}

export class FakeGraph {
  readonly items = new Map<string, StoredItem>();
  readonly sessions = new Map<string, UploadSession>();
  readonly requests: RecordedRequest[] = [];
  /** Items per list page (forces pagination). */
  pageSize = 200;
  token = 'test-access-token';
  /** Fragments that are stored but whose response is lost (client sees a network error). */
  loseFragmentResponses = 0;
  private failures: Failure[] = [];
  private nextId = 1;
  private clock = Date.parse('2026-03-01T00:00:00Z');

  seed(
    name: string,
    bytes: Uint8Array = new Uint8Array(8),
    options: { folder?: boolean } = {},
  ): StoredItem {
    const item: StoredItem = {
      id: `ITEM!${this.nextId++}`,
      name,
      bytes,
      createdDateTime: new Date((this.clock += 60_000)).toISOString(),
      ...(options.folder ? { folder: true } : {}),
    };
    this.items.set(item.id, item);
    return item;
  }

  /** The next `times` requests matching `match` get `response` instead. */
  fail(match: (req: Request) => boolean, response: () => Response, times = 1): void {
    for (let i = 0; i < times; i++) this.failures.push({ match, response });
  }

  private driveItem(item: StoredItem) {
    return {
      id: item.id,
      name: item.name,
      size: item.bytes.length,
      createdDateTime: item.createdDateTime,
      ...(item.folder
        ? { folder: { childCount: 0 } }
        : { file: { mimeType: 'application/octet-stream' } }),
    };
  }

  private authorized(request: Request): boolean {
    return request.headers.get('authorization') === `Bearer ${this.token}`;
  }

  private store(name: string, bytes: Uint8Array): StoredItem | null {
    if ([...this.items.values()].some((i) => i.name === name)) return null;
    return this.seed(name, bytes);
  }

  handlers(): HttpHandler[] {
    const record = async (request: Request) => {
      this.requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.get('authorization'),
        contentRange: request.headers.get('content-range'),
        bodyBytes: (await request.clone().arrayBuffer()).byteLength,
      });
      const index = this.failures.findIndex((f) => f.match(request));
      if (index >= 0) return this.failures.splice(index, 1)[0]!.response();
      return null;
    };

    return [
      http.all(`${GRAPH}/*`, async ({ request }) => {
        const failure = await record(request);
        if (failure) return failure;
        if (!this.authorized(request)) {
          return HttpResponse.json(
            { error: { code: 'InvalidAuthenticationToken' } },
            { status: 401 },
          );
        }
        const url = new URL(request.url);
        const path = decodeURIComponent(url.pathname.replace('/v1.0', ''));

        if (request.method === 'GET' && path === '/me/drive/special/approot/children') {
          const all = [...this.items.values()];
          const start = Number(url.searchParams.get('$skiptoken') ?? 0);
          const page = all.slice(start, start + this.pageSize);
          const next = start + this.pageSize;
          return HttpResponse.json({
            value: page.map((i) => this.driveItem(i)),
            ...(next < all.length
              ? {
                  '@odata.nextLink': `${GRAPH}/me/drive/special/approot/children?$skiptoken=${next}`,
                }
              : {}),
          });
        }

        const simple = /^\/me\/drive\/special\/approot:\/(.+):\/content$/.exec(path);
        if (simple && request.method === 'PUT') {
          if (url.searchParams.get('@microsoft.graph.conflictBehavior') !== 'fail') {
            return HttpResponse.json(
              { error: { code: 'expected conflictBehavior=fail' } },
              { status: 400 },
            );
          }
          const item = this.store(simple[1]!, new Uint8Array(await request.arrayBuffer()));
          if (!item)
            return HttpResponse.json({ error: { code: 'nameAlreadyExists' } }, { status: 409 });
          return HttpResponse.json(this.driveItem(item), { status: 201 });
        }

        const session = /^\/me\/drive\/special\/approot:\/(.+):\/createUploadSession$/.exec(path);
        if (session && request.method === 'POST') {
          const id = `session-${this.nextId++}`;
          this.sessions.set(id, { name: session[1]!, total: null, received: [], next: 0 });
          return HttpResponse.json({
            uploadUrl: `${UPLOAD_HOST}/up/${id}`,
            expirationDateTime: '2026-03-02T00:00:00Z',
          });
        }

        const itemPath = /^\/me\/drive\/items\/(.+)$/.exec(path);
        if (itemPath) {
          const item = this.items.get(itemPath[1]!);
          if (!item) return HttpResponse.json({ error: { code: 'itemNotFound' } }, { status: 404 });
          if (request.method === 'DELETE') {
            this.items.delete(item.id);
            return new HttpResponse(null, { status: 204 });
          }
          if (request.method === 'GET') {
            return HttpResponse.json({
              ...this.driveItem(item),
              '@microsoft.graph.downloadUrl': `${DOWNLOAD_HOST}/dl/${encodeURIComponent(item.id)}`,
            });
          }
        }
        return HttpResponse.json({ error: { code: 'unexpected request' } }, { status: 400 });
      }),

      http.all(`${UPLOAD_HOST}/up/:id`, async ({ request, params }) => {
        const failure = await record(request);
        if (failure) return failure;
        const session = this.sessions.get(String(params.id));
        if (!session)
          return HttpResponse.json({ error: { code: 'itemNotFound' } }, { status: 404 });
        if (request.method === 'DELETE') {
          this.sessions.delete(String(params.id));
          return new HttpResponse(null, { status: 204 });
        }
        if (request.method === 'GET') {
          return HttpResponse.json({ nextExpectedRanges: [`${session.next}-`] });
        }
        if (request.headers.get('authorization')) {
          // Graph docs: the pre-authenticated URL rejects a bearer token.
          return HttpResponse.json({ error: { code: 'unauthenticated' } }, { status: 401 });
        }
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(request.headers.get('content-range') ?? '');
        if (!range) return HttpResponse.json({ error: { code: 'invalidRange' } }, { status: 400 });
        const [from, to, total] = range.slice(1).map(Number) as [number, number, number];
        const body = new Uint8Array(await request.arrayBuffer());
        if (from !== session.next)
          return HttpResponse.json({ error: { code: 'invalidRange' } }, { status: 416 });
        if (body.length !== to - from + 1)
          return HttpResponse.json({ error: { code: 'invalidRange' } }, { status: 400 });
        const isLast = to + 1 === total;
        if (!isLast && body.length % (320 * 1024) !== 0) {
          return HttpResponse.json({ error: { code: 'fragmentNot320KiB' } }, { status: 400 });
        }
        session.total = total;
        session.received.push(body);
        session.next = to + 1;
        if (!isLast && this.loseFragmentResponses > 0) {
          this.loseFragmentResponses--;
          return HttpResponse.error();
        }
        if (!isLast) {
          return HttpResponse.json({ nextExpectedRanges: [`${session.next}-`] }, { status: 202 });
        }
        this.sessions.delete(String(params.id));
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const part of session.received) {
          bytes.set(part, offset);
          offset += part.length;
        }
        const item = this.store(session.name, bytes);
        if (!item)
          return HttpResponse.json({ error: { code: 'nameAlreadyExists' } }, { status: 409 });
        return HttpResponse.json(this.driveItem(item), { status: 201 });
      }),

      http.get(`${DOWNLOAD_HOST}/dl/:id`, async ({ request, params }) => {
        const failure = await record(request);
        if (failure) return failure;
        if (request.headers.get('authorization')) {
          return HttpResponse.json({ error: { code: 'unexpected token' } }, { status: 400 });
        }
        const item = this.items.get(decodeURIComponent(String(params.id)));
        if (!item) return new HttpResponse(null, { status: 404 });
        return new HttpResponse(new Uint8Array(item.bytes), {
          headers: { 'Content-Type': 'application/octet-stream' },
        });
      }),
    ];
  }
}
