// Network-first service worker (a cache-first worker froze phones on old versions). The cache is the offline fallback:
// the pass, its device key (IndexedDB) and its signed credential (localStorage) then work with no signal.
const C='audrain-events-v12';
const FILES=['./','./index.html','./sb.js','./manifest.webmanifest','./icon-192.png','./icon-512.png','./apple-touch-icon.png',
  './photos/field.jpg','./photos/alfa.jpg','./photos/hilltop.jpg','./photos/lawn.jpg','./photos/stage.jpg','./photos/wine.jpg',
  './shared/pass.js','./shared/track.js','./shared/checkout.js',
  './vendor/qrcode-generator/qrcode.js','./vendor/noble-ed25519/index.js','./vendor/supabase-js/supabase.js','./vendor/supabase-js/591.supabase.js'];
// Third-party GETs worth keeping for offline use (Leaflet, the jsQR fallback, fonts). Never the API or Stripe.
const CDN=/^https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;
// One missing file must not break the install, so each file is cached on its own.
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>Promise.all(FILES.map(f=>c.add(f).catch(()=>{})))));self.skipWaiting();});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))));self.clients.claim();});
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;const u=new URL(e.request.url),same=u.origin===location.origin,cdn=CDN.test(u.href);if(!same&&!cdn)return;
  e.respondWith(fetch(e.request).then(res=>{if(res.ok||(cdn&&res.type==='opaque')){const copy=res.clone();caches.open(C).then(c=>c.put(e.request,copy)).catch(()=>{});}return res;})
    .catch(()=>caches.match(e.request).then(r=>r||(e.request.mode==='navigate'?caches.match('./'):Response.error()))));});
