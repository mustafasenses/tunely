// Build-time service worker generator: precaches every emitted asset + public files,
// with a content-hashed cache name so old caches are cleaned up on activate.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

/** Public files not needed offline (social preview, crawler hints). */
const SKIP = new Set(['og-image.png', 'robots.txt']);

function listFiles(dir: string, root = dir): string[] {
  let out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out = out.concat(listFiles(p, root));
    else out.push(relative(root, p).split('\\').join('/'));
  }
  return out;
}

export function serviceWorker(): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'tunely-service-worker',
    apply: 'build',
    configResolved(c) {
      config = c;
    },
    generateBundle(_options, bundle) {
      const hash = createHash('sha256');
      const files = new Set<string>();
      for (const [fileName, item] of Object.entries(bundle)) {
        if (fileName.endsWith('.map')) continue;
        files.add(fileName);
        hash.update(fileName);
        hash.update(item.type === 'chunk' ? item.code : typeof item.source === 'string' ? item.source : Buffer.from(item.source));
      }
      const publicDir = config.publicDir;
      if (publicDir) {
        for (const f of listFiles(publicDir)) {
          if (SKIP.has(f) || f === 'sw.js') continue;
          files.add(f);
          hash.update(f);
          hash.update(readFileSync(join(publicDir, f)));
        }
      }
      files.delete('index.html'); // served as the scope root ("./")
      const precache = ['./', ...[...files].sort()];
      hash.update(swSource('', [])); // SW logic changes also bump the cache version
      const version = hash.digest('hex').slice(0, 12);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: swSource(version, precache) });
    },
  };
}

function swSource(version: string, precache: string[]): string {
  return `// Generated at build time by scripts/vite-plugin-sw.ts — do not edit.
const CACHE = 'tunely-${version}';
const PRECACHE = ${JSON.stringify(precache)};
const scope = self.registration.scope;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE.map((p) => new Request(new URL(p, scope), { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('tunely-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}

const scopePath = new URL(scope).pathname; // "/tunely/"

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // "/tunely" (no trailing slash) is the app too. Browsers only route it here when the SW's
  // scope covers it (Service-Worker-Allowed); then send it to the shell, online or offline.
  if (req.mode === 'navigate' && url.pathname === scopePath.slice(0, -1)) {
    event.respondWith(Response.redirect(scope + url.search + url.hash, 301));
    return;
  }
  if (!url.href.startsWith(scope)) return;

  if (req.mode === 'navigate') {
    // Network first (fresh app after deploys), cached shell when offline or slow.
    event.respondWith(
      Promise.race([fetch(req), timeout(4000)])
        .then((res) => {
          if (res.ok && url.pathname === new URL(scope).pathname) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(scope, copy));
          }
          return res;
        })
        .catch(() => caches.match(scope, { ignoreVary: true }).then((r) => r || caches.match(req, { ignoreSearch: true, ignoreVary: true })).then((r) => r || Response.error())),
    );
    return;
  }

  // Static assets: cache first (filenames are content-hashed), then network (and cache it).
  event.respondWith(
    caches.match(req, { ignoreSearch: true, ignoreVary: true }).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
`;
}
