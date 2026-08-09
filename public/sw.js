// Service worker mínimo: solo habilita la instalación como app.
// No cachea /api/* — cada análisis y guardado siempre va a la red.
const SHELL_CACHE = "chichabyte-shell-v1";
const SHELL_FILES = ["/", "/manifest.json", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith("/api/")) return; // nunca cachear la API
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});
