// Regenerates PNG icons, favicon.ico and the Open Graph image from public/icon.svg.
// Usage: node scripts/generate-assets.mjs   (needs `npx playwright install chromium` once)
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const pub = fileURLToPath(new URL('../public/', import.meta.url));
const icon = await readFile(pub + 'icon.svg', 'utf8');
// Maskable / apple-touch variant: full-bleed square (the platform applies its own mask).
const fullBleed = icon.replaceAll(' rx="114"', '');
const dataUrl = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });

async function renderSvg(svg, size, file) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent"><img src="${dataUrl(svg)}" width="${size}" height="${size}" style="display:block"></body></html>`,
  );
  await page.waitForFunction(() => document.images[0].complete);
  const png = await page.screenshot({ omitBackground: true, type: 'png' });
  if (file) await writeFile(pub + file, png);
  return png;
}

await renderSvg(icon, 192, 'icon-192.png');
await renderSvg(icon, 512, 'icon-512.png');
await renderSvg(fullBleed, 192, 'icon-maskable-192.png');
await renderSvg(fullBleed, 512, 'icon-maskable-512.png');
await renderSvg(fullBleed, 180, 'apple-touch-icon.png');
const fav32 = await renderSvg(icon, 32, 'favicon-32.png');
const fav16 = await renderSvg(icon, 16);

// favicon.ico with embedded PNGs (16 + 32).
{
  const imgs = [
    [16, fav16],
    [32, fav32],
  ];
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(imgs.length, 4);
  let offset = 6 + 16 * imgs.length;
  const dir = [];
  for (const [s, png] of imgs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(s, 0);
    e.writeUInt8(s, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    dir.push(e);
  }
  await writeFile(pub + 'favicon.ico', Buffer.concat([header, ...dir, ...imgs.map((i) => i[1])]));
}

// Open Graph image 1200×630.
await page.setViewportSize({ width: 1200, height: 630 });
await page.setContent(`<!doctype html><html><head><style>
  html,body{margin:0;width:1200px;height:630px;overflow:hidden}
  body{font-family:-apple-system,'SF Pro Display','Helvetica Neue',Arial,sans-serif;color:#eef1f5;
    background:radial-gradient(70% 90% at 30% 20%,rgba(120,140,255,.14),transparent 70%),
               radial-gradient(60% 80% at 85% 100%,rgba(61,220,151,.10),transparent 70%),#0e1013;
    display:flex;align-items:center;gap:72px;padding:0 110px;box-sizing:border-box}
  img{width:300px;height:300px;flex:none;filter:drop-shadow(0 24px 48px rgba(0,0,0,.55))}
  h1{margin:0;font-size:120px;font-weight:700;letter-spacing:-.035em;line-height:1}
  p{margin:22px 0 0;font-size:38px;line-height:1.3;color:#a8b0bc;max-width:15em}
  .pill{display:inline-flex;align-items:center;gap:12px;margin-top:34px;padding:12px 24px;border-radius:999px;
    background:rgba(61,220,151,.14);color:#3ddc97;font-size:28px;font-weight:650}
</style></head><body>
  <img src="${dataUrl(icon)}" alt="">
  <div><h1>Tunely</h1><p>Accurate chromatic tuner for kalimba, guitar, voice &amp; more.</p>
  <div class="pill">✓ Free · Works offline · Private</div></div>
</body></html>`);
await page.waitForFunction(() => document.images[0].complete);
await writeFile(pub + 'og-image.png', await page.screenshot({ type: 'png' }));

await browser.close();
console.log('assets written to public/');
