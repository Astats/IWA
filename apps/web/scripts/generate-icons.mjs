#!/usr/bin/env node
// Generates the PWA icons (PNG) without extra dependencies: a teal rounded square with three
// white "ledger lines", matching public/favicon.svg. Usage: node scripts/generate-icons.mjs
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
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

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5);
      const i = y * (size * 4 + 1) + 1 + x * 4;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Icon in a 64-unit design space; `maskable` fills the square and keeps content in the safe zone. */
function icon(size, { maskable = false } = {}) {
  const s = size / 64;
  const radius = maskable ? 0 : 14;
  const scale = maskable ? 0.7 : 1; // maskable: content within the central 80% safe zone
  const lines = [
    [18, 46, 40],
    [18, 38, 30],
    [18, 46, 20],
  ]; // [x1, x2, y]
  return png(size, (px, py) => {
    const x = px / s;
    const y = py / s;
    // Rounded-rect background with anti-aliased corners.
    const dx = Math.max(radius - x, 0, x - (64 - radius));
    const dy = Math.max(radius - y, 0, y - (64 - radius));
    const d = Math.hypot(dx, dy);
    const bgAlpha = radius === 0 ? 1 : Math.min(1, Math.max(0, radius - d + 0.5));
    if (bgAlpha <= 0) return [0, 0, 0, 0];
    // Lines (stroke width 5, round caps), scaled around the center for maskable icons.
    const cx = 32 + (x - 32) / scale;
    const cy = 32 + (y - 32) / scale;
    let lineCover = 0;
    for (const [x1, x2, ly] of lines) {
      const nx = Math.min(Math.max(cx, x1), x2);
      const dist = Math.hypot(cx - nx, cy - ly);
      lineCover = Math.max(lineCover, Math.min(1, Math.max(0, 2.5 - dist + 0.5)));
    }
    const mix = (a, b) => Math.round(a * (1 - lineCover) + b * lineCover);
    return [
      mix(TEAL[0], WHITE[0]),
      mix(TEAL[1], WHITE[1]),
      mix(TEAL[2], WHITE[2]),
      Math.round(bgAlpha * 255),
    ];
  });
}

const files = {
  'pwa-192x192.png': icon(192),
  'pwa-512x512.png': icon(512),
  'maskable-512x512.png': icon(512, { maskable: true }),
  'apple-touch-icon.png': icon(180, { maskable: true }),
};
for (const [name, data] of Object.entries(files)) {
  writeFileSync(path.join(out, name), data);
  console.log(`wrote public/${name} (${data.length} bytes)`);
}
