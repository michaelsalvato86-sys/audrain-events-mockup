Vendored third-party libraries (no CDN at runtime). Each folder keeps the upstream license.

| Folder | Package | Version | License | Used by |
|---|---|---|---|---|
| supabase-js/ | @supabase/supabase-js (dist/umd) | 2.45.4 | MIT | order/, sb.js (when preloaded) |
| qrcode-generator/ | qrcode-generator (Kazuhiko Arase) | 1.4.4 | MIT | shared/pass.js renderQR |
| noble-ed25519/ | @noble/ed25519 (ES module) | 2.1.0 | MIT | shared/pass.js verify fallback when WebCrypto lacks Ed25519 |

Files are copied unchanged from the npm tarballs (2026-10-16). 591.supabase.js is a webpack chunk that
only throws "ws does not work in the browser"; it is kept so the UMD build never 404s.
