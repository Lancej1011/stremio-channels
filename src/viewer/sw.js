/* Headend deliberately keeps authenticated HTML, guide data and media out of caches. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
