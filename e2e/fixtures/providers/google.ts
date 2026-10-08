import type { BrowserContext, Route } from '@playwright/test';

import { ALLOWED_ORIGINS } from '../guard.fixture';

/*
 * Fake Google Identity Services script + Drive v3 appDataFolder for e2e. The stand-in GIS script
 * implements the token-client API the app uses and records each initTokenClient config on
 * window.__fakeGis (a property of the mocked third-party script, not of the app).
 */

const ACCOUNTS = 'https://accounts.google.com';
const API = 'https://www.googleapis.com';
export const GOOGLE_ACCESS_TOKEN = 'e2e-google-access-token';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': 'Location, Range',
};

const FAKE_GIS = (token: string) => `
(() => {
  const configs = [];
  window.__fakeGis = { configs, deny: false };
  window.google = { accounts: { oauth2: {
    initTokenClient(config) {
      configs.push({ client_id: config.client_id, scope: config.scope });
      return { requestAccessToken() {
        setTimeout(() => {
          if (window.__fakeGis.deny) config.callback({ error: 'access_denied' });
          else config.callback({ access_token: ${JSON.stringify(token)}, expires_in: 3599,
            scope: config.scope, token_type: 'Bearer' });
        }, 30);
      } };
    },
    hasGrantedAllScopes(response, ...scopes) {
      const granted = (response.scope || '').split(' ');
      return scopes.every((s) => granted.includes(s));
    },
    revoke(_token, done) { if (done) done({ successful: true }); },
  } } };
})();
`;

interface DriveFile {
  id: string;
  name: string;
  bytes: Buffer;
  createdTime: string;
}

export class FakeGoogle {
  readonly files = new Map<string, DriveFile>();
  readonly apiRequests: Array<{ method: string; url: string; authorized: boolean }> = [];
  private validToken = GOOGLE_ACCESS_TOKEN;
  private nextId = 1;

  revoke(): void {
    this.validToken = 'revoked';
  }

  async install(context: BrowserContext): Promise<void> {
    for (const origin of [ACCOUNTS, API]) ALLOWED_ORIGINS.add(origin);
    await context.route(`${ACCOUNTS}/gsi/client`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/javascript',
        body: FAKE_GIS(GOOGLE_ACCESS_TOKEN),
      }),
    );
    await context.route(`${API}/**`, (route) => this.api(route));
  }

  private json(route: Route, body: unknown, status = 200) {
    return route.fulfill({ status, headers: CORS, contentType: 'application/json', json: body });
  }

  private resource(f: DriveFile) {
    return { id: f.id, name: f.name, size: String(f.bytes.length), createdTime: f.createdTime };
  }

  private async api(route: Route) {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const authorized = request.headers()['authorization'] === `Bearer ${this.validToken}`;
    this.apiRequests.push({ method: request.method(), url: request.url(), authorized });
    if (!authorized) return this.json(route, { error: { code: 401 } }, 401);
    const url = new URL(request.url());

    if (url.pathname === '/drive/v3/files' && request.method() === 'GET') {
      return this.json(route, { files: [...this.files.values()].map((f) => this.resource(f)) });
    }
    if (url.pathname === '/upload/drive/v3/files' && request.method() === 'POST') {
      const body = request.postDataBuffer() ?? Buffer.alloc(0);
      const boundary = /boundary=(.+)$/.exec(request.headers()['content-type'] ?? '')?.[1] ?? '';
      const parts = body.toString('latin1').split(`--${boundary}`).slice(1, -1);
      const [meta = '', media = ''] = parts.map((p) => p.slice(p.indexOf('\r\n\r\n') + 4, -2));
      const metadata = JSON.parse(meta) as { name: string; parents: string[] };
      if (metadata.parents.join() !== 'appDataFolder') return this.json(route, {}, 400);
      const file: DriveFile = {
        id: `g-${this.nextId++}`,
        name: metadata.name,
        bytes: Buffer.from(media, 'latin1'),
        createdTime: new Date().toISOString(),
      };
      this.files.set(file.id, file);
      return this.json(route, this.resource(file));
    }
    const match = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    const file = match ? this.files.get(decodeURIComponent(match[1] ?? '')) : undefined;
    if (match && !file) return this.json(route, { error: { code: 404 } }, 404);
    if (file && request.method() === 'DELETE') {
      this.files.delete(file.id);
      return route.fulfill({ status: 204, headers: CORS });
    }
    if (file && request.method() === 'GET') {
      if (url.searchParams.get('alt') === 'media') {
        return route.fulfill({
          status: 200,
          headers: { ...CORS, 'Content-Type': 'application/octet-stream' },
          body: file.bytes,
        });
      }
      return this.json(route, this.resource(file));
    }
    return this.json(route, { error: { message: 'unexpected request' } }, 400);
  }
}
