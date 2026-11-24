// PWA / deploy checks against the production build served under /tunely/.
import { expect, test } from './helpers';

const SITE = 'https://mustafasenses.github.io/tunely/';

test('manifest is linked, valid JSON, scoped to /tunely/, and its icons load', async ({ page, request, baseURL }) => {
  await page.goto('./');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBe('/tunely/manifest.webmanifest');
  const manifestUrl = new URL(href!, baseURL).href;
  const res = await request.get(manifestUrl);
  expect(res.status()).toBe(200);
  const manifest = JSON.parse(await res.text());
  expect(manifest).toMatchObject({ short_name: 'Tunely', scope: '/tunely/', start_url: '/tunely/', display: 'standalone' });
  expect(manifest.name).toContain('Tunely');
  expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
  const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes);
  expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
  expect(manifest.icons.some((i: { purpose?: string }) => i.purpose?.includes('maskable'))).toBe(true);
  for (const icon of manifest.icons as { src: string; type: string }[]) {
    const r = await request.get(new URL(icon.src, manifestUrl).href);
    expect(r.status(), icon.src).toBe(200);
    expect(r.headers()['content-type'], icon.src).toContain(icon.type.split('+')[0]);
  }
});

test('every icon / social image referenced by index.html returns 200', async ({ request, baseURL }) => {
  const html = await (await request.get(baseURL!)).text();
  const urls = new Set<string>();
  for (const m of html.matchAll(/<link[^>]+rel="(?:icon|apple-touch-icon|manifest)"[^>]*>/g)) {
    urls.add(/href="([^"]+)"/.exec(m[0])![1]);
  }
  for (const m of html.matchAll(/<meta[^>]+(?:property|name)="(?:og:image|twitter:image)"[^>]*>/g)) {
    urls.add(/content="([^"]+)"/.exec(m[0])![1]);
  }
  expect(urls.size).toBeGreaterThanOrEqual(6);
  for (const u of urls) {
    // Absolute social URLs point at the live site: check the same path on the local build.
    expect(u.startsWith('/tunely/') || u.startsWith(SITE), `${u} is under /tunely/`).toBe(true);
    const local = new URL(u.startsWith(SITE) ? u.slice(SITE.length) : u, baseURL).href;
    const r = await request.get(local);
    expect(r.status(), u).toBe(200);
  }
  // Built assets are referenced under the base path too.
  expect(html).toMatch(/src="\/tunely\/assets\/index-[\w-]+\.js"/);
});

test('service worker registers under /tunely/ and the app works offline', async ({ page, context, baseURL }) => {
  await page.goto('./');
  const reg = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.ready; // resolves once installed (precached) + active
    return { scope: r.scope, script: r.active?.scriptURL };
  });
  expect(reg.scope).toBe(baseURL);
  expect(reg.script).toBe(new URL('sw.js', baseURL).href);
  await expect.poll(() => page.evaluate(() => caches.keys())).toEqual([expect.stringMatching(/^tunely-/)]);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Start tuning' })).toBeVisible();
  await expect(page.locator('.brand-name')).toHaveText('Tunely');

  // A deep link with a query, and the lazily loaded mock-engine chunk, also come from the cache.
  await page.goto('./?mock=intune');
  await page.locator('#btn-start').click();
  await expect(page.locator('#view-tuner')).toHaveAttribute('data-locked', 'true');
  await context.setOffline(false);
});
