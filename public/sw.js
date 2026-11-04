/*
 * Depeche's service worker. It does one thing: shows a notification when an answer is ready
 * after the person left the app, and opens that chat when they tap it. It caches nothing, so the
 * app always loads fresh from the server.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let note = {};
  try {
    note = event.data ? event.data.json() : {};
  } catch {
    note = {};
  }
  const title = typeof note.title === "string" && note.title ? note.title : "Depeche";
  const url = typeof note.url === "string" && note.url.startsWith("/") ? note.url : "/";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof note.body === "string" ? note.body : "Your answer is ready.",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: typeof note.tag === "string" ? note.tag : undefined,
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of windows) {
        if (new URL(w.url).origin !== url.origin) continue;
        await w.focus();
        if (w.url !== url.href && "navigate" in w) await w.navigate(url.href).catch(() => {});
        return;
      }
      await self.clients.openWindow(url.href);
    })(),
  );
});
