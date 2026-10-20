#!/usr/bin/env node
// Generates the app icons and splash screens (PNG) without extra dependencies: a teal rounded
// square with three white "ledger lines", matching public/favicon.svg. Writes the PWA icons to
// public/ and the Android launcher icons and splash screens (BUILD_PLAN 4.4).
// Usage: node scripts/generate-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEAL = [15, 118, 110];
const WHITE = [255, 255, 255];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(width, height, pixel) {
  const row = width * 4 + 1;
  const raw = Buffer.alloc(height * row);
  for (let y = 0; y < height; y++) {
    raw[y * row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5);
      const i = y * row + 1 + x * 4;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const LINES = [
  [18, 46, 40],
  [18, 38, 30],
  [18, 46, 20],
]; // [x1, x2, y] in a 64-unit design space

/** Coverage (0–1) of the ledger lines (stroke width 5, round caps) at a design-space point. */
function lineCover(x, y) {
  let cover = 0;
  for (const [x1, x2, ly] of LINES) {
    const nx = Math.min(Math.max(x, x1), x2);
    const dist = Math.hypot(x - nx, y - ly);
    cover = Math.max(cover, Math.min(1, Math.max(0, 2.5 - dist + 0.5)));
  }
  return cover;
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v * (1 - t) + b[i] * t));

/**
 * Square icon in the 64-unit design space. `shape`: rounded square, full square or circle;
 * `scale` shrinks the lines around the centre (safe zones); `background: false` draws only the
 * white lines on transparency (Android adaptive-icon foreground).
 */
function icon(size, { shape = 'rounded', scale = 1, background = true } = {}) {
  const s = size / 64;
  return png(size, size, (px, py) => {
    const x = px / s;
    const y = py / s;
    let bgAlpha = 1;
    if (shape === 'rounded') {
      const radius = 14;
      const dx = Math.max(radius - x, 0, x - (64 - radius));
      const dy = Math.max(radius - y, 0, y - (64 - radius));
      bgAlpha = Math.min(1, Math.max(0, radius - Math.hypot(dx, dy) + 0.5));
    } else if (shape === 'circle') {
      bgAlpha = Math.min(1, Math.max(0, 32 - Math.hypot(x - 32, y - 32) + 0.5));
    }
    const cover = lineCover(32 + (x - 32) / scale, 32 + (y - 32) / scale);
    if (!background) return [...WHITE, Math.round(cover * 255)];
    if (bgAlpha <= 0) return [0, 0, 0, 0];
    return [...mix(TEAL, WHITE, cover), Math.round(bgAlpha * 255)];
  });
}

/** Opaque teal splash screen with the lines centred, a quarter of the shorter side wide. */
function splash(width, height) {
  const unit = (Math.min(width, height) * 0.25) / 28; // the lines span 28 design units
  return png(width, height, (px, py) => {
    const cover = lineCover(32 + (px - width / 2) / unit, 30 + (py - height / 2) / unit);
    return [...mix(TEAL, WHITE, cover), 255];
  });
}

const res = 'android/app/src/main/res';
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const SPLASH = {
  mdpi: [480, 320],
  hdpi: [800, 480],
  xhdpi: [1280, 720],
  xxhdpi: [1600, 960],
  xxxhdpi: [1920, 1280],
};

const files = {
  'public/pwa-192x192.png': icon(192),
  'public/pwa-512x512.png': icon(512),
  'public/maskable-512x512.png': icon(512, { shape: 'square', scale: 0.7 }),
  'public/apple-touch-icon.png': icon(180, { shape: 'square', scale: 0.7 }),
  [`${res}/drawable/splash.png`]: splash(480, 320),
};
for (const [density, factor] of Object.entries(DENSITIES)) {
  files[`${res}/mipmap-${density}/ic_launcher.png`] = icon(48 * factor);
  files[`${res}/mipmap-${density}/ic_launcher_round.png`] = icon(48 * factor, {
    shape: 'circle',
    scale: 0.8,
  });
  // Adaptive icon: 108 dp canvas, launchers show at least the central 66 dp.
  files[`${res}/mipmap-${density}/ic_launcher_foreground.png`] = icon(108 * factor, {
    background: false,
    scale: 66 / 108,
  });
  const [w, h] = SPLASH[density];
  files[`${res}/drawable-land-${density}/splash.png`] = splash(w, h);
  files[`${res}/drawable-port-${density}/splash.png`] = splash(h, w);
}

for (const [name, data] of Object.entries(files)) {
  const file = path.join(web, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
  console.log(`wrote ${name} (${data.length} bytes)`);
}
