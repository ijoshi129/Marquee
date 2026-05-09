// One-off PNG renderer for the PWA icons + iOS splash images + favicon.ico.
// Run with:
//   node scripts/render-icons.mjs
// Source SVGs live in client/public/. Outputs go alongside them.
//
// NOTE: `sharp` and `png-to-ico` are intentionally NOT in package.json —
// only needed when regenerating these assets. If you change the icon SVG
// and need to rerun:  npm install --no-save sharp png-to-ico

import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(__dirname, '..', 'public');

const RENDERS = [
  { src: 'icon.svg',          out: 'favicon-16.png',         size: 16 },
  { src: 'icon.svg',          out: 'favicon-32.png',         size: 32 },
  { src: 'icon.svg',          out: 'icon-192.png',           size: 192 },
  { src: 'icon.svg',          out: 'icon-512.png',           size: 512 },
  { src: 'icon.svg',          out: 'apple-touch-icon.png',   size: 180 },
  { src: 'icon-maskable.svg', out: 'icon-maskable-512.png',  size: 512 },
];

for (const { src, out, size } of RENDERS) {
  const svg = await readFile(path.join(PUBLIC, src));
  await sharp(svg, { density: 384 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(path.join(PUBLIC, out));
  console.log(`rendered ${out} (${size}×${size})`);
}

// iOS PWA splash screens — covers iPhone 11+ Pro line + iPad Pro.
// Each splash is the dark bg color with the icon centered, sized to the device.
const SPLASHES = [
  // iPhone @3x portrait
  { out: 'splash-1290x2796.png', w: 1290, h: 2796 }, // iPhone 14/15/16 Pro Max
  { out: 'splash-1284x2778.png', w: 1284, h: 2778 }, // iPhone 12/13 Pro Max, 14 Plus
  { out: 'splash-1242x2688.png', w: 1242, h: 2688 }, // iPhone XS Max, 11 Pro Max
  { out: 'splash-1242x2208.png', w: 1242, h: 2208 }, // iPhone 8 Plus, 7 Plus, 6s Plus
  { out: 'splash-1179x2556.png', w: 1179, h: 2556 }, // iPhone 14/15/16 Pro
  { out: 'splash-1170x2532.png', w: 1170, h: 2532 }, // iPhone 12/13/14/15/16
  { out: 'splash-1125x2436.png', w: 1125, h: 2436 }, // iPhone X / XS / 11 Pro
  // iPhone @2x portrait
  { out: 'splash-828x1792.png',  w: 828,  h: 1792 }, // iPhone XR, 11
  { out: 'splash-750x1334.png',  w: 750,  h: 1334 }, // iPhone 6/7/8/SE 2/SE 3
  // iPad @2x portrait
  { out: 'splash-2048x2732.png', w: 2048, h: 2732 }, // iPad Pro 12.9"
  { out: 'splash-1668x2388.png', w: 1668, h: 2388 }, // iPad Pro 11"
  { out: 'splash-1668x2224.png', w: 1668, h: 2224 }, // iPad Pro 10.5"
  { out: 'splash-1620x2160.png', w: 1620, h: 2160 }, // iPad 10.2", 10.5"
  { out: 'splash-1536x2048.png', w: 1536, h: 2048 }, // iPad mini, Air, 9.7"
];

const ICON_RATIO = 0.32; // icon takes 32% of the smaller dimension
const BG = { r: 8, g: 8, b: 10, alpha: 1 }; // matches --bg

const iconSvg = await readFile(path.join(PUBLIC, 'icon.svg'));

// Render each spec in both portrait and landscape orientations.
const splashJobs = SPLASHES.flatMap(({ out, w, h }) => {
  const landscapeName = out.replace(/(\d+)x(\d+)/, (_, a, b) => `${b}x${a}`);
  return [
    { out, w, h },
    { out: landscapeName, w: h, h: w },
  ];
});

// Multi-resolution favicon.ico for legacy browser support (Safari especially).
// Pack 16, 32, 48 px PNGs into a single .ico.
const faviconSizes = [16, 32, 48];
const faviconPngs = await Promise.all(
  faviconSizes.map((size) =>
    sharp(iconSvg, { density: 384 }).resize(size, size).png().toBuffer()
  )
);
const icoBuffer = await pngToIco(faviconPngs);
await writeFile(path.join(PUBLIC, 'favicon.ico'), icoBuffer);
console.log(`rendered favicon.ico (${faviconSizes.join(', ')} px)`);

for (const { out, w, h } of splashJobs) {
  const iconSize = Math.round(Math.min(w, h) * ICON_RATIO);
  const iconPng = await sharp(iconSvg, { density: 384 })
    .resize(iconSize, iconSize)
    .png()
    .toBuffer();

  await sharp({
    create: { width: w, height: h, channels: 4, background: BG },
  })
    .composite([{ input: iconPng, gravity: 'center' }])
    .png({ compressionLevel: 9 })
    .toFile(path.join(PUBLIC, out));
  console.log(`rendered ${out} (${w}×${h})`);
}
