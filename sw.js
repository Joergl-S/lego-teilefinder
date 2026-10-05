/**
 * sw.js – Service Worker des LEGO-Teilefinders.
 *
 * - App-Shell wird beim Installieren vorgeladen → App startet offline.
 * - Eigene Dateien: „Cache zuerst“, neue Version kommt über CACHE_VERSION.
 * - data/*.csv.gz und Brickognize/Rebrickable werden NICHT gecacht
 *   (Teiledaten liegen nach dem ersten Laden in IndexedDB).
 * - OpenCV.js (ca. 10 MB) wird beim Installieren im Hintergrund mitgeladen.
 *
 * Bei jeder Änderung an App-Dateien CACHE_VERSION erhöhen!
 */

const CACHE_VERSION = 'lego-tf-1.0.1';
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/ui.js',
  'js/settings.js',
  'js/db.js',
  'js/data.js',
  'js/search.js',
  'js/color.js',
  'js/image.js',
  'js/segment.js',
  'js/segment-worker.js',
  'js/recognize.js',
  'js/match.js',
  'js/overlay.js',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_VERSION).then(async c => {
    await c.addAll(SHELL);
    // Groß, aber für Offline-Betrieb nötig. Scheitert es, wird es beim ersten Gebrauch geladen.
    try { await c.add('vendor/opencv.js'); } catch (e) { /* später */ }
  }));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('lego-tf-') && k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Die Seite schickt „skipWaiting“, wenn der Nutzer „Jetzt neu laden“ tippt.
self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;                 // fremde Server: Browser regelt das
  if (!url.pathname.startsWith(new URL('./', self.location).pathname)) return;
  if (url.pathname.includes('/data/')) return;                      // Teiledaten nicht doppelt speichern

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(hit => {
      if (hit) return hit;
      return fetch(req).then(res => {
        // Unbekannte eigene Dateien (z. B. später nachgeladene Module) mitcachen
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => {
        // Offline und nicht im Cache: bei Seitenaufrufen die App-Shell liefern
        if (req.mode === 'navigate') return caches.match('index.html');
        throw new Error('offline');
      });
    })
  );
});
