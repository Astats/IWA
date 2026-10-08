import type { BrowserContext, Route } from '@playwright/test';

import { ALLOWED_ORIGINS } from '../guard.fixture';

/*
 * Fake Microsoft identity platform + Graph app folder for e2e (TEST_PLAN §3.3 fakeProviders).
 * The real MSAL popup flow runs against it: authorize (302 back to the redirect bridge with code
 * and state), token redemption, then Graph calls with the issued bearer token.
 */

const LOGIN = 'https://login.microsoftonline.com';
const GRAPH = 'https://graph.microsoft.com';
const DOWNLOAD = 'https://e2e.files.1drv.com';
export const MS_ACCESS_TOKEN = 'e2e-ms-access-token';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': '*',
};

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

interface FileEntry {
  id: string;
  name: string;
  bytes: Buffer;
  createdDateTime: string;
}

export class FakeMicrosoft {
  readonly authorizeUrls: URL[] = [];
  readonly files = new Map<string, FileEntry>();
  /** Every Graph request: method, URL and whether it carried the issued token. */
  readonly graphRequests: Array<{ method: string; url: string; authorized: boolean }> = [];
  private nonce = '';
  private validToken = MS_ACCESS_TOKEN;
  private nextId = 1;

  constructor(private readonly clientId: string) {}

  /** Simulates the user revoking the app's access: the issued token stops working. */
  revoke(): void {
    this.validToken = 'revoked';
  }

  async install(context: BrowserContext): Promise<void> {
    for (const origin of [LOGIN, GRAPH, DOWNLOAD]) ALLOWED_ORIGINS.add(origin);
    await context.route(`${LOGIN}/**`, (route) => this.login(route));
    await context.route(`${GRAPH}/**`, (route) => this.graph(route));
    await context.route(`${DOWNLOAD}/**`, (route) => this.download(route));
  }

  private json(route: Route, body: unknown, status = 200) {
    return route.fulfill({ status, headers: CORS, contentType: 'application/json', json: body });
  }

  private async login(route: Route) {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const url = new URL(request.url());
    if (url.pathname.endsWith('/discovery/instance')) {
      return this.json(route, {
        tenant_discovery_endpoint: `${LOGIN}/common/v2.0/.well-known/openid-configuration`,
        'api-version': '1.1',
        metadata: [
          {
            preferred_network: 'login.microsoftonline.com',
            preferred_cache: 'login.windows.net',
            aliases: ['login.microsoftonline.com', 'login.windows.net', 'login.microsoft.com'],
          },
        ],
      });
    }
    if (url.pathname.endsWith('/.well-known/openid-configuration')) {
      return this.json(route, {
        token_endpoint: `${LOGIN}/common/oauth2/v2.0/token`,
        authorization_endpoint: `${LOGIN}/common/oauth2/v2.0/authorize`,
        end_session_endpoint: `${LOGIN}/common/oauth2/v2.0/logout`,
        issuer: `${LOGIN}/{tenantid}/v2.0`,
        jwks_uri: `${LOGIN}/common/discovery/v2.0/keys`,
        response_modes_supported: ['query', 'fragment', 'form_post'],
      });
    }
    if (url.pathname.endsWith('/oauth2/v2.0/authorize')) {
      this.authorizeUrls.push(url);
      this.nonce = url.searchParams.get('nonce') ?? '';
      const params = new URLSearchParams({
        code: 'e2e-auth-code',
        state: url.searchParams.get('state') ?? '',
        client_info: b64url({ uid: 'e2e-uid', utid: 'e2e-utid' }),
      });
      const redirect = url.searchParams.get('redirect_uri') ?? '';
      const location =
        url.searchParams.get('response_mode') === 'query'
          ? `${redirect}?${params.toString()}`
          : `${redirect}#${params.toString()}`;
      return route.fulfill({ status: 302, headers: { location } });
    }
    if (url.pathname.endsWith('/oauth2/v2.0/token')) {
      const now = Math.floor(Date.now() / 1000);
      const idToken = [
        b64url({ alg: 'RS256', typ: 'JWT', kid: 'e2e' }),
        b64url({
          aud: this.clientId,
          iss: `${LOGIN}/e2e-utid/v2.0`,
          iat: now,
          nbf: now,
          exp: now + 3600,
          name: 'E2E User',
          preferred_username: 'e2e@example.com',
          oid: 'e2e-uid',
          sub: 'e2e-sub',
          tid: 'e2e-utid',
          nonce: this.nonce,
          ver: '2.0',
        }),
        'e2e-signature',
      ].join('.');
      return this.json(route, {
        token_type: 'Bearer',
        scope: 'Files.ReadWrite.AppFolder openid profile',
        expires_in: 3600,
        ext_expires_in: 3600,
        access_token: MS_ACCESS_TOKEN,
        id_token: idToken,
        client_info: b64url({ uid: 'e2e-uid', utid: 'e2e-utid' }),
      });
    }
    return this.json(route, { error: 'unexpected_request' }, 400);
  }

  private async graph(route: Route) {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const authorized = request.headers()['authorization'] === `Bearer ${this.validToken}`;
    this.graphRequests.push({ method: request.method(), url: request.url(), authorized });
    if (!authorized)
      return this.json(route, { error: { code: 'InvalidAuthenticationToken' } }, 401);
    const url = new URL(request.url());
    const path = decodeURIComponent(url.pathname.replace('/v1.0', ''));

    if (request.method() === 'GET' && path === '/me/drive/special/approot/children') {
      return this.json(route, { value: [...this.files.values()].map((f) => this.item(f)) });
    }
    const upload = /^\/me\/drive\/special\/approot:\/(.+):\/content$/.exec(path);
    if (upload && request.method() === 'PUT') {
      const entry: FileEntry = {
        id: `E2E!${this.nextId++}`,
        name: upload[1] ?? '',
        bytes: request.postDataBuffer() ?? Buffer.alloc(0),
        createdDateTime: new Date().toISOString(),
      };
      this.files.set(entry.id, entry);
      return this.json(route, this.item(entry), 201);
    }
    const itemPath = /^\/me\/drive\/items\/(.+)$/.exec(path);
    const entry = itemPath ? this.files.get(itemPath[1] ?? '') : undefined;
    if (itemPath && !entry) return this.json(route, { error: { code: 'itemNotFound' } }, 404);
    if (entry && request.method() === 'GET') {
      return this.json(route, {
        ...this.item(entry),
        '@microsoft.graph.downloadUrl': `${DOWNLOAD}/${encodeURIComponent(entry.id)}`,
      });
    }
    if (entry && request.method() === 'DELETE') {
      this.files.delete(entry.id);
      return route.fulfill({ status: 204, headers: CORS });
    }
    return this.json(route, { error: { code: 'unexpected_request' } }, 400);
  }

  private async download(route: Route) {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.slice(1));
    const entry = this.files.get(id);
    if (!entry) return route.fulfill({ status: 404, headers: CORS });
    return route.fulfill({
      status: 200,
      headers: { ...CORS, 'Content-Type': 'application/octet-stream' },
      body: entry.bytes,
    });
  }

  private item(f: FileEntry) {
    return {
      id: f.id,
      name: f.name,
      size: f.bytes.length,
      createdDateTime: f.createdDateTime,
      file: { mimeType: 'application/octet-stream' },
    };
  }
}
