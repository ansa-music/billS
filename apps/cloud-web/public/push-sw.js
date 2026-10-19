/* Web Push for the installed cabinet (Supabase mode). Imported into the generated service worker
   (vite.config.ts → workbox.importScripts). Payload from the `owner`/`notify` Edge Functions:
   { title, body, data: { kind, clubId, alertId?, url? } } — url relative to the cabinet or absolute. */
/* eslint-disable no-restricted-globals */

function tsTargetUrl(data) {
  var scope = self.registration.scope;
  if (data && typeof data.url === 'string' && data.url) return new URL(data.url, scope).href;
  if (data && typeof data.clubId === 'string' && data.clubId) return scope + '#/clubs/' + encodeURIComponent(data.clubId);
  return scope;
}

self.addEventListener('push', function (event) {
  var payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch (e) {
      payload = { body: event.data.text() };
    }
  }
  var data = payload.data || {};
  var title = payload.title || 'TS';
  var scope = self.registration.scope;
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || '',
      icon: new URL('icons/icon-192.png', scope).href,
      badge: new URL('icons/icon-192.png', scope).href,
      lang: 'ru',
      tag: data.alertId || data.kind || undefined,
      data: { url: tsTargetUrl(data) },
    }),
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || self.registration.scope;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        var client = list[i];
        if (client.url.indexOf(self.registration.scope) === 0 && 'focus' in client) {
          return client.focus().then(function (c) {
            return c && 'navigate' in c ? c.navigate(url) : c;
          });
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
