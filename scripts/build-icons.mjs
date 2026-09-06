import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', 'public', 'icons');
mkdirSync(outDir, { recursive: true });

const dots = [
  { x: 100, y: 412, c: '#e0473c' },
  { x: 206, y: 306, c: '#ffd633' },
  { x: 312, y: 312 - 100, c: '#3b7fe0' },
  { x: 100 + 3 * 106, y: 412 - 3 * 106, c: '#3fb56b' },
  { x: 100 + 4 * 106, y: 412 - 4 * 106, c: '#ffd633' },
];

const svg = `
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#182238"/>
      <stop offset="1" stop-color="#0b0f18"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="96" fill="url(#bg)"/>
  <line x1="${dots[0].x}" y1="${dots[0].y}" x2="${dots[4].x}" y2="${dots[4].y}" stroke="#ffffff" stroke-opacity="0.25" stroke-width="18" stroke-linecap="round"/>
  ${dots.map((d) => `<circle cx="${d.x}" cy="${d.y}" r="44" fill="${d.c}" stroke="rgba(0,0,0,0.35)" stroke-width="4"/>`).join('\n  ')}
</svg>`;

const svgBuffer = Buffer.from(svg);

async function make(size, file, { opaque = false } = {}) {
  let img = sharp(svgBuffer).resize(size, size);
  if (opaque) img = img.flatten({ background: '#0f1420' });
  await img.png().toFile(path.join(outDir, file));
  console.log('wrote', file);
}

await make(192, 'icon-192.png');
await make(512, 'icon-512.png');
await make(180, 'apple-touch-icon.png', { opaque: true });
