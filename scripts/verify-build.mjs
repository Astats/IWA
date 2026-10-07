#!/usr/bin/env node
// Build integrity checks (TEST_PLAN §7.4, SEC-W14). Runs after `vite build` of apps/web.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cspDirectives } from '../apps/web/csp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'apps/web/dist');

/** Third-party origins that built assets may reference at runtime (none in the local phases). */
const ALLOWED_RUNTIME_ORIGINS = new Set();

/** Strings that must never ship in production (e2e-only hooks). */
const FORBIDDEN_MARKERS = ['__E2E_HOOKS__'];

/** Precache entries must be app-shell assets only (no data / API responses). */
const APP_SHELL_ASSET = /\.(html|js|css|wasm|svg|png|ico|webmanifest|woff2?)$/;

const errors = [];

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

if (!existsSync(dist)) {
  console.error(`verify-build: ${dist} does not exist. Run the web build first.`);
  process.exit(1);
}

const files = walk(dist);
const rel = (/** @type {string} */ f) => path.relative(dist, f).replaceAll('\\', '/');

// 1. No source maps, no debugger statements, no e2e markers.
for (const file of files) {
  if (file.endsWith('.map')) errors.push(`source map shipped: ${rel(file)}`);
  if (!/\.(js|mjs|html|css)$/.test(file)) continue;
  const text = readFileSync(file, 'utf8');
  for (const marker of FORBIDDEN_MARKERS) {
    if (text.includes(marker)) errors.push(`e2e marker "${marker}" found in ${rel(file)}`);
  }
  if (/\.(js|mjs)$/.test(file) && /(^|[;{}\s])debugger\s*;/.test(text)) {
    errors.push(`debugger statement in ${rel(file)}`);
  }
  if (/[#@] sourceMappingURL=/.test(text)) errors.push(`sourceMappingURL comment in ${rel(file)}`);
}

// 2. index.html carries the expected CSP without unsafe-inline/unsafe-eval, and no inline code.
const html = readFileSync(path.join(dist, 'index.html'), 'utf8');
const meta = html.match(/<meta[^>]+http-equiv="Content-Security-Policy"[^>]+content="([^"]+)"/i);
if (!meta) {
  errors.push('index.html lacks the CSP meta tag');
} else {
  const csp = (meta[1] ?? '')
    .replaceAll('&#39;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&');
  const directives = csp.split(';').map((d) => d.trim());
  if (/unsafe-inline/.test(csp) || /(^|[\s])'unsafe-eval'/.test(csp)) {
    errors.push(`CSP contains unsafe-inline/unsafe-eval: ${csp}`);
  }
  for (const [name, values] of Object.entries(cspDirectives)) {
    const expected = [name, ...values].join(' ');
    if (!directives.includes(expected))
      errors.push(`CSP directive missing or changed: "${expected}"`);
  }
}
if (/<script(?![^>]*\bsrc=)[^>]*>\s*\S/i.test(html)) errors.push('inline <script> in index.html');
if (/<style[\s>]/i.test(html)) errors.push('inline <style> in index.html');
if (/\sstyle=/i.test(html)) errors.push('inline style attribute in index.html');

// 3. Third-party runtime origins referenced from the HTML shell or the web manifest.
for (const file of files.filter((f) => /\.(html|webmanifest)$/.test(f))) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/\b(?:src|href|url)\s*[=(:]\s*["']?(https?:\/\/[^/"' )]+)/gi)) {
    const origin = (match[1] ?? '').toLowerCase();
    if (!ALLOWED_RUNTIME_ORIGINS.has(origin)) {
      errors.push(`third-party origin ${origin} referenced in ${rel(file)}`);
    }
  }
}

// 4. Service worker precache contains only app-shell assets; no runtime caching routes.
const sw = path.join(dist, 'sw.js');
if (existsSync(sw)) {
  const swText = readFileSync(sw, 'utf8');
  for (const m of swText.matchAll(/url:\s*"([^"]+)"/g)) {
    const url = m[1] ?? '';
    if (!APP_SHELL_ASSET.test(url)) errors.push(`unexpected precache entry: ${url}`);
  }
  if (/\bruntimeCaching\b|\bStaleWhileRevalidate\b|\bNetworkFirst\b|\bCacheFirst\b/.test(swText)) {
    errors.push('service worker contains runtime caching strategies');
  }
}

if (errors.length > 0) {
  console.error(`verify-build: ${errors.length} problem(s):\n - ${errors.join('\n - ')}`);
  process.exit(1);
}
console.log(`verify-build: OK (${files.length} files checked)`);
