import { createHash } from 'node:crypto';

import type { BrowserContext, Route } from '@playwright/test';

import { ALLOWED_ORIGINS } from '../guard.fixture';

/*
 * Fake Dropbox for e2e: the authorize page redirects straight back to the app with a code (or a
 * forged state, on request), the token endpoint verifies PKCE, and the API serves an App folder.
 */

const WWW = 'https://www.dropbox.com';
const API = 'https://api.dropboxapi.com';
const CONTENT = 'https://content.dropboxapi.com';
export const DROPBOX_ACCESS_TOKEN = 'e2e-dropbox-access-token';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Expose-Headers': 'Dropbox-API-Result',
};

interface StoredFile {
  id: string;
  name: string;
  bytes: Buffer;
  server_modified: string;
}

export class FakeDropbox {
  readonly authorizeUrls: URL[] = [];
  readonly tokenRequests: URLSearchParams[] = [];
  readonly files = new Map<string, StoredFile>();
  readonly apiRequests: Array<{ url: string; authorized: boolean }> = [];
  /** When set, the authorize step returns this state instead of the one it received. */
  forgeState: string | null = null;
  private challenge = '';
  private validToken = DROPBOX_ACCESS_TOKEN;
  private nextId = 1;

  revoke(): void {
    this.validToken = 'revoked';
  }

  async install(context: BrowserContext): Promise<void> {
    for (const origin of [WWW, API, CONTENT]) ALLOWED_ORIGINS.add(origin);
    await context.route(`${WWW}/oauth2/authorize**`, (route) => this.authorize(route));
    await context.route(`${API}/**`, (route) => this.api(route));
    await context.route(`${CONTENT}/**`, (route) => this.content(route));
  }

  private json(route: Route, body: unknown, status = 200) {
    return route.fulfill({ status, headers: CORS, contentType: 'application/json', json: body });
  }

  private authorize(route: Route) {
    const url = new URL(route.request().url());
    this.authorizeUrls.push(url);
    this.challenge = url.searchParams.get('code_challenge') ?? '';
    const back = new URL(url.searchParams.get('redirect_uri') ?? '');
    back.searchParams.set('code', 'e2e-dropbox-code');
    back.searchParams.set('state', this.forgeState ?? url.searchParams.get('state') ?? '');
    return route.fulfill({ status: 302, headers: { location: back.toString() } });
  }

  private meta(f: StoredFile) {
    return {
      '.tag': 'file',
      id: f.id,
      name: f.name,
      size: f.bytes.length,
      server_modified: f.server_modified,
    };
  }

  private authorized(route: Route): boolean {
    const ok = route.request().headers()['authorization'] === `Bearer ${this.validToken}`;
    this.apiRequests.push({ url: route.request().url(), authorized: ok });
    return ok;
  }

  private api(route: Route) {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const path = new URL(request.url()).pathname;
    if (path === '/oauth2/token') {
      const form = new URLSearchParams(request.postData() ?? '');
      this.tokenRequests.push(form);
      const verifier = form.get('code_verifier') ?? '';
      const ok =
        form.get('code') === 'e2e-dropbox-code' &&
        createHash('sha256').update(verifier).digest('base64url') === this.challenge;
      if (!ok) return this.json(route, { error: 'invalid_grant' }, 400);
      return this.json(route, {
        access_token: DROPBOX_ACCESS_TOKEN,
        token_type: 'bearer',
        expires_in: 14400,
        scope: 'files.content.read files.content.write files.metadata.read',
        uid: '1',
        account_id: 'dbid:e2e',
      });
    }
    if (!this.authorized(route)) {
      return this.json(route, { error_summary: 'expired_access_token/' }, 401);
    }
    const body = JSON.parse(request.postData() ?? '{}') as { path?: string };
    if (path === '/2/files/list_folder') {
      return this.json(route, {
        entries: [...this.files.values()].map((f) => this.meta(f)),
        cursor: 'c',
        has_more: false,
      });
    }
    if (path === '/2/files/delete_v2') {
      const file = this.files.get(body.path ?? '');
      if (!file) return this.json(route, { error_summary: 'path_lookup/not_found/' }, 409);
      this.files.delete(file.id);
      return this.json(route, { metadata: this.meta(file) });
    }
    return this.json(route, { error_summary: 'unexpected/' }, 400);
  }

  private content(route: Route) {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (!this.authorized(route)) {
      return this.json(route, { error_summary: 'expired_access_token/' }, 401);
    }
    const arg = JSON.parse(request.headers()['dropbox-api-arg'] ?? '{}') as { path: string };
    const path = new URL(request.url()).pathname;
    if (path === '/2/files/upload') {
      // mode=add + strict_conflict: an existing name is a conflict, as on real Dropbox.
      if ([...this.files.values()].some((f) => `/${f.name}` === arg.path)) {
        return this.json(route, { error_summary: 'path/conflict/file/..' }, 409);
      }
      const file: StoredFile = {
        id: `id:e2e${this.nextId++}`,
        name: arg.path.slice(1),
        bytes: request.postDataBuffer() ?? Buffer.alloc(0),
        server_modified: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      };
      this.files.set(file.id, file);
      return this.json(route, this.meta(file));
    }
    if (path === '/2/files/download') {
      const file = this.files.get(arg.path);
      if (!file) return this.json(route, { error_summary: 'path/not_found/' }, 409);
      return route.fulfill({
        status: 200,
        headers: {
          ...CORS,
          'Content-Type': 'application/octet-stream',
          'Dropbox-API-Result': JSON.stringify(this.meta(file)),
        },
        body: file.bytes,
      });
    }
    return this.json(route, { error_summary: 'unexpected/' }, 400);
  }
}
