const CACHE_NAME = 'nav-app-v3-tmap-20260812-sector';
const APP_SHELL = ['./', './index.html', './manifest.json'];

function dataCacheKey(request) {
  const url = new URL(request.url);
  url.search = '';
  return new Request(url.toString(), {
    method: 'GET',
    headers: request.headers,
    mode: request.mode,
    credentials: request.credentials,
    redirect: request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    integrity: request.integrity,
  });
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.allSettled(APP_SHELL.map(url => cache.add(url)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // TMAP API / SDK 응답은 절대 캐시하지 않는다 (경로·교통정보는 항상 최신이어야 함).
  if (url.hostname.endsWith('openapi.sk.com')) return;

  // 경로·도로 원본은 갱신이 잦아 네트워크를 먼저 본다 (오프라인이면 캐시로 폴백).
  if (url.pathname.endsWith('/routes.json') || url.pathname.endsWith('/hd_roads.json')) {
    event.respondWith((async () => {
      const cacheKey = dataCacheKey(request);
      try {
        const res = await fetch(request, { cache: 'no-store' });
        if (res && res.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(cacheKey, res.clone());
        }
        return res;
      } catch (_) {
        return (await caches.match(cacheKey)) ||
               (await caches.match(request, { ignoreSearch: true })) ||
               Response.error();
      }
    })());
    return;
  }

  // 페이지 이동은 네트워크 우선 — 새 index.html이 즉시 반영되도록.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request, { cache: 'no-store' });
        const cache = await caches.open(CACHE_NAME);
        cache.put('./index.html', response.clone());
        return response;
      } catch (_) {
        return (await caches.match(request)) ||
               (await caches.match('./index.html')) ||
               Response.error();
      }
    })());
    return;
  }

  // 동일 출처 정적 파일은 캐시 우선 + 백그라운드 갱신.
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cached = await caches.match(request);
      const network = fetch(request).then(async res => {
        if (res && res.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, res.clone());
        }
        return res;
      }).catch(() => null);
      return cached || (await network) || Response.error();
    })());
  }
});
