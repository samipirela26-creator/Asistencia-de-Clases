/* ============================================================
   AsistApp · service-worker.js
   Estrategia: Cache First para assets, Network First para datos
   ============================================================ */

const CACHE_NAME    = 'asistapp-v33';
const OFFLINE_URL   = './offline.html';

// Archivos que se precargan al instalar el SW
const PRECACHE_URLS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './reports.js',
  './firebase-config.js',
  './offline.html',
  './manifest.json',
  './icons/icon-192x192.png',
  './icons/icon-512x512.png',
  // Librerías CDN — disponibles offline
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.31/jspdf.plugin.autotable.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore-compat.js',
];

// Dominios que usan Firebase / CDNs — siempre ir a la red primero
const NETWORK_FIRST_PATTERNS = [
  'firestore.googleapis.com',
  'firebase.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
];

// ── Instalación — precachear todo ────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[SW] Precacheando assets...');
      return cache.addAll(PRECACHE_URLS);
    }).then(() => {
      console.log('[SW] Instalado y listo.');
      return self.skipWaiting();
    })
  );
});

// ── Activación — limpiar cachés viejos ───────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => {
          console.log('[SW] Eliminando caché vieja:', k);
          return caches.delete(k);
        })
      )
    ).then(() => {
      console.log('[SW] Activado — controlando todas las páginas.');
      return self.clients.claim();
    })
  );
});

// ── Fetch — lógica de caché ───────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Ignorar extensiones de Chrome, peticiones POST, etc.
  if (request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;

  // Firebase / Firestore / APIs externas → NO interceptar.
  // Estas conexiones (streaming en tiempo real) no se pueden cachear:
  // si el SW las intercepta, rompe la sincronización. Las dejamos pasar directo.
  const isFirebase = NETWORK_FIRST_PATTERNS.some(p => url.hostname.includes(p));
  if (isFirebase) {
    return; // el navegador maneja la petición sin el SW
  }

  // CDN de Google Fonts → Stale While Revalidate
  if (url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com')) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // Archivos PROPIOS de la app (mismo origen) → Network First
  // Así siempre se busca la versión más nueva; el caché solo se usa offline.
  // Esto evita tener que borrar el historial para ver los cambios.
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Librerías externas con versión fija (jsPDF, Firebase, etc.) → Cache First
  event.respondWith(cacheFirst(request));
});

// ── Estrategias ───────────────────────────────────────────────

// Cache First: sirve desde caché; si falla va a red; si no hay nada → offline
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Si es navegación, mostrar página offline
    if (request.mode === 'navigate') {
      return caches.match(OFFLINE_URL);
    }
    return new Response('Sin conexión', { status: 503 });
  }
}

// Network First: intenta red; si falla, usa caché; si no hay → offline
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (request.mode === 'navigate') return caches.match(OFFLINE_URL);
    return new Response('Sin conexión', { status: 503 });
  }
}

// Stale While Revalidate: sirve caché inmediato y actualiza en background
async function staleWhileRevalidate(request) {
  const cache  = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);

  return cached || fetchPromise;
}

// ── Mensaje desde la app para forzar actualización ────────────
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
