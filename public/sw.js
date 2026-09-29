// 開いたことのある画面をオフラインでも表示するための簡単なキャッシュ。
// 新しい版を配信したら VERSION を変えると、古いキャッシュが入れ替わる。
const VERSION = "v1.6.2";
const CACHE = "kondate-" + VERSION;
const FILES = ["/", "/index.html", "/config.js", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;            // フォントや価格APIは通常どおり通信する
  // ページは「通信を先に、だめならキャッシュ」。更新がすぐ届く。
  e.respondWith(fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; }).catch(() => caches.match(req).then((r) => r || caches.match("/index.html"))));
});
