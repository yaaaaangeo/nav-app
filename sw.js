// ══════════════════════════════════════════════════════════
//  자율주행 데이터 취득 — 서비스워커
//  앱 셸(이 앱 자체 파일들)은 캐시해서 오프라인에서도 앱이 켜지도록 하고,
//  지도 타일·OSRM·역지오코딩·CDN 같은 외부 요청은 그대로 네트워크로 보낸다
//  (실시간 데이터라 캐시하면 안 됨).
// ══════════════════════════════════════════════════════════
const CACHE_NAME = 'nav-app-shell-v1';
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .catch((e) => console.warn('SW install cache 실패:', e))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 다른 출처(지도 타일, OSRM, Nominatim, CDN 등)는 캐시하지 않고 그대로 네트워크로
  if (url.origin !== location.origin) return;

  // 같은 출처의 앱 셸 파일 — 캐시 우선, 실패 시 네트워크에서 받아 캐시 갱신
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const resClone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
