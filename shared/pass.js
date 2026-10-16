/* Audrain pass credential - device key, rotating QR, badge QR and scanner verify. Contract:
   audrain-apps/docs/2027-BUILD-CONTRACT.md ("Credential + QR").
     Rotating (app)  AUD1.<b64u(claims)>.<b64u(ed25519_sig)>.<t>.<b64u(p256_sig("serial|t"))>   t = floor(unix/15)
     Badge / Wallet  AUD1.<b64u(claims)>.<b64u(ed25519_sig)>
   The Ed25519 signature covers the ASCII bytes of the claims segment exactly as it appears in the QR
   (JWS style, so nobody re-serialises JSON). verify() also accepts a signature over the decoded JSON bytes.
   The P-256 device key is made by WebCrypto as non-extractable and kept in IndexedDB, so it never leaves
   the phone; its public half travels in the claims as "dk" (33-byte compressed point, b64u).
   No network calls here: the page fetches the bundle from the credential function and passes it in. */
(function () {
  "use strict";
  var STEP = 15;
  var DB_NAME = "audrain-pass", DB_STORE = "keys", KEY_ID = "device-p256";
  var subtle = (window.crypto && window.crypto.subtle) || null;
  var here = (document.currentScript && document.currentScript.src) || location.href;
  var VENDOR = new URL("../vendor/", here).href;
  var enc = new TextEncoder(), dec = new TextDecoder();

  /* ---------- bytes ---------- */
  function b64uEncode(bytes) {
    if (typeof bytes === "string") bytes = enc.encode(bytes);
    bytes = new Uint8Array(bytes);
    var s = "";
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function b64uDecode(str) {
    if (typeof str !== "string" || !/^[A-Za-z0-9_-]*$/.test(str)) throw new Error("bad b64u");
    var s = str.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function concat(a, b) { var o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; }
  function bytesToBig(b) { var h = ""; for (var i = 0; i < b.length; i++) h += (b[i] < 16 ? "0" : "") + b[i].toString(16); return BigInt("0x" + (h || "0")); }
  function bigToBytes(n, len) { var h = n.toString(16); while (h.length < len * 2) h = "0" + h; var o = new Uint8Array(len); for (var i = 0; i < len; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; }

  /* ---------- P-256 point compression (WebCrypto only imports uncompressed raw keys everywhere) ---------- */
  var P256_P = BigInt("0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff");
  var P256_B = BigInt("0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b");
  function modpow(b, e, m) { var r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; }
  function compressPoint(raw65) {
    raw65 = new Uint8Array(raw65);
    if (raw65.length !== 65 || raw65[0] !== 4) throw new Error("expected uncompressed P-256 point");
    var out = new Uint8Array(33);
    out[0] = (raw65[64] & 1) ? 3 : 2;
    out.set(raw65.subarray(1, 33), 1);
    return out;
  }
  function decompressPoint(c33) {
    if (c33.length !== 33 || (c33[0] !== 2 && c33[0] !== 3)) throw new Error("bad compressed point");
    var x = bytesToBig(c33.subarray(1));
    if (x >= P256_P) throw new Error("bad point");
    var rhs = ((x * x % P256_P) * x - 3n * x + P256_B) % P256_P;
    if (rhs < 0n) rhs += P256_P;
    var y = modpow(rhs, (P256_P + 1n) / 4n, P256_P);      // p = 3 mod 4
    if (y * y % P256_P !== rhs) throw new Error("point not on curve");
    if ((y & 1n) !== BigInt(c33[0] & 1)) y = P256_P - y;
    return concat(concat(new Uint8Array([4]), bigToBytes(x, 32)), bigToBytes(y, 32));
  }

  /* ---------- device key in IndexedDB ---------- */
  function idb() {
    return new Promise(function (res, rej) {
      try {
        var r = indexedDB.open(DB_NAME, 1);
        r.onupgradeneeded = function () { r.result.createObjectStore(DB_STORE); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      } catch (e) { rej(e); }
    });
  }
  function idbOp(mode, fn) {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(DB_STORE, mode), req = fn(tx.objectStore(DB_STORE));
        tx.oncomplete = function () { db.close(); res(req && req.result); };
        tx.onerror = tx.onabort = function () { db.close(); rej(tx.error); };
      });
    });
  }
  var memoryKey = null;   // private window / blocked storage: key lives for this page only
  var keyPromise = null;
  function describe(pair, persistent) {
    return Promise.all([subtle.exportKey("jwk", pair.publicKey), subtle.exportKey("raw", pair.publicKey)]).then(function (r) {
      var jwk = { kty: "EC", crv: "P-256", x: r[0].x, y: r[0].y };
      return thumbprint(jwk).then(function (tp) {
        return { jwk: jwk, compressed: b64uEncode(compressPoint(r[1])), thumbprint: tp, persistent: persistent, _pair: pair };
      });
    });
  }
  function thumbprint(jwk) {   // RFC 7638
    var j = '{"crv":"' + jwk.crv + '","kty":"EC","x":"' + jwk.x + '","y":"' + jwk.y + '"}';
    return subtle.digest("SHA-256", enc.encode(j)).then(b64uEncode);
  }
  function ensureDeviceKey() {
    if (!subtle) return Promise.reject(new Error("This browser cannot create a secure pass key"));
    if (keyPromise) return keyPromise;
    keyPromise = idbOp("readonly", function (s) { return s.get(KEY_ID); })
      .catch(function () { return null; })
      .then(function (stored) {
        if (stored && stored.privateKey && stored.publicKey) return describe(stored, true);
        if (memoryKey) return describe(memoryKey, false);
        return subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]).then(function (pair) {
          return idbOp("readwrite", function (s) { return s.put({ privateKey: pair.privateKey, publicKey: pair.publicKey, created: Date.now() }, KEY_ID); })
            .then(function () { return describe(pair, true); })
            .catch(function () { memoryKey = pair; return describe(pair, false); });
        });
      });
    keyPromise.catch(function () { keyPromise = null; });
    return keyPromise;
  }
  /* Wipe the device key (sign-out on a shared phone). The next ensureDeviceKey() makes a new one, which
     must be registered again through the credential function. */
  function resetDeviceKey() {
    keyPromise = null; memoryKey = null;
    return idbOp("readwrite", function (s) { return s.delete(KEY_ID); }).catch(function () {});
  }

  /* ---------- QR strings ---------- */
  function claimsSegment(bundle) {
    if (!bundle || (!bundle.claimsB64 && !bundle.claims) || !bundle.sig) throw new Error("credential bundle missing");
    return bundle.claimsB64 || b64uEncode(JSON.stringify(bundle.claims));
  }
  function claimsOf(bundle) { return bundle.claims || JSON.parse(dec.decode(b64uDecode(bundle.claimsB64))); }
  function unixNow(now) {
    if (now == null) return Date.now() / 1000;
    if (now instanceof Date) return now.getTime() / 1000;
    return now > 1e11 ? now / 1000 : now;   // accept ms or seconds
  }
  function badgeString(bundle) { return "AUD1." + claimsSegment(bundle) + "." + bundle.sig; }
  /* Promise<string>. opts.now (unix s or ms) is for tests; opts.key overrides the device key. */
  function qrString(bundle, opts) {
    opts = opts || {};
    var head = badgeString(bundle), serial = claimsOf(bundle).s;
    var t = Math.floor(unixNow(opts.now) / STEP);
    return (opts.key ? Promise.resolve(opts.key) : ensureDeviceKey()).then(function (k) {
      var priv = k._pair ? k._pair.privateKey : k.privateKey;
      return subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, enc.encode(serial + "|" + t));
    }).then(function (sig) { return head + "." + t + "." + b64uEncode(sig); });
  }
  /* Seconds until the current code rolls over - drives the countdown ring in the app. */
  function secondsLeft(now) { var s = unixNow(now); return STEP - (s % STEP); }

  /* ---------- Ed25519 verify: WebCrypto first, vendored @noble/ed25519 otherwise ---------- */
  var nativeEd = null;   // null = unknown, true/false after first probe
  var noble = null;
  function loadNoble() {
    if (!noble) noble = import(VENDOR + "noble-ed25519/index.js");
    return noble;
  }
  var keyCache = {};
  function edVerifyNative(pubRaw, sig, msg) {
    var ck = b64uEncode(pubRaw);
    var kp = keyCache[ck] || (keyCache[ck] = subtle.importKey("raw", pubRaw, { name: "Ed25519" }, false, ["verify"]));
    return kp.then(function (key) { return subtle.verify({ name: "Ed25519" }, key, sig, msg); });
  }
  function edVerify(pubRaw, sig, msg) {
    if (sig.length !== 64 || pubRaw.length !== 32) return Promise.resolve(false);
    var viaNoble = function () { return loadNoble().then(function (ed) { return ed.verifyAsync(sig, msg, pubRaw); }).catch(function () { return false; }); };
    if (API._forceNoble || nativeEd === false || !subtle) return viaNoble();
    return edVerifyNative(pubRaw, sig, msg).then(function (ok) { nativeEd = true; return ok; }, function (e) {
      if (nativeEd === true && e && e.name !== "NotSupportedError") return false;
      nativeEd = false; delete keyCache[b64uEncode(pubRaw)]; return viaNoble();
    });
  }
  function p256Verify(compressedB64u, sig, msg) {
    var raw;
    try { raw = decompressPoint(b64uDecode(compressedB64u)); } catch (e) { return Promise.resolve(false); }
    if (sig.length !== 64) return Promise.resolve(false);
    return subtle.importKey("raw", raw, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"])
      .then(function (k) { return subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k, sig, msg); })
      .catch(function () { return false; });
  }

  /* revoked: Set|Array of "serial" (all revs) or "serial:rev", or [{serial, rev}], or Map serial->rev.
     A revocation at rev R kills every credential with r <= R; a re-issued credential (higher r) stays good. */
  function isRevoked(revoked, serial, rev) {
    if (!revoked) return false;
    var hit = function (s, r) { return s === serial && (r == null || r === "" || rev <= Number(r)); };
    if (revoked instanceof Map) return revoked.has(serial) && hit(serial, revoked.get(serial));
    var list = revoked instanceof Set ? Array.from(revoked) : Array.isArray(revoked) ? revoked : [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (typeof e === "string") {
        var at = e.lastIndexOf(":");
        if (e === serial) return true;
        if (at > 0 && hit(e.slice(0, at), e.slice(at + 1))) return true;
      } else if (e && hit(e.serial, e.rev)) return true;
    }
    return false;
  }

  /* verify(qr, {publicKeys:{kid: rawB64u}, revoked, now, skewSteps:2, requireRotating:false})
     -> Promise<{ok, reason, claims, rotating, t}>. Reasons: bad_format, bad_signature, revoked,
     expired, not_yet_valid, stale_code, bad_device_sig (and not_rotating when requireRotating is set). */
  function verify(qr, opts) {
    opts = opts || {};
    var out = function (ok, reason, claims, rotating, t) { return { ok: ok, reason: reason, claims: claims || null, rotating: !!rotating, t: t == null ? null : t }; };
    var parts = typeof qr === "string" ? qr.trim().split(".") : [];
    if (parts[0] !== "AUD1" || (parts.length !== 3 && parts.length !== 5)) return Promise.resolve(out(false, "bad_format"));
    var claims, sig, rotating = parts.length === 5, t = null, devSig = null;
    try {
      claims = JSON.parse(dec.decode(b64uDecode(parts[1])));
      sig = b64uDecode(parts[2]);
      if (!claims || claims.v !== 1 || typeof claims.s !== "string") throw new Error("claims");
      if (rotating) {
        if (!/^\d{1,12}$/.test(parts[3])) throw new Error("t");
        t = Number(parts[3]); devSig = b64uDecode(parts[4]);
      }
    } catch (e) { return Promise.resolve(out(false, "bad_format", claims && typeof claims === "object" ? claims : null, rotating)); }
    var keys = opts.publicKeys || {}, pubB64 = keys[claims.kid];
    var pub;
    try { pub = b64uDecode(pubB64 || ""); } catch (e) { pub = new Uint8Array(0); }
    var msgSeg = enc.encode(parts[1]);
    return edVerify(pub, sig, msgSeg).then(function (ok) {
      return ok ? ok : edVerify(pub, sig, b64uDecode(parts[1]));   // tolerate signing of the raw JSON bytes
    }).then(function (ok) {
      if (!ok) return out(false, "bad_signature", claims, rotating, t);
      if (isRevoked(opts.revoked, claims.s, Number(claims.r) || 0)) return out(false, "revoked", claims, rotating, t);
      var now = unixNow(opts.now);
      if (claims.vf != null && now < Number(claims.vf)) return out(false, "not_yet_valid", claims, rotating, t);
      if (claims.vt != null && now > Number(claims.vt)) return out(false, "expired", claims, rotating, t);
      if (!rotating) return opts.requireRotating ? out(false, "not_rotating", claims, false) : out(true, null, claims, false);
      var skew = opts.skewSteps == null ? 2 : opts.skewSteps;
      if (Math.abs(t - Math.floor(now / STEP)) > skew) return out(false, "stale_code", claims, true, t);
      if (!claims.dk) return out(false, "bad_device_sig", claims, true, t);
      return p256Verify(claims.dk, devSig, enc.encode(claims.s + "|" + t)).then(function (good) {
        return good ? out(true, null, claims, true, t) : out(false, "bad_device_sig", claims, true, t);
      });
    }).catch(function () { return out(false, "bad_signature", claims, rotating, t); });
  }

  /* ---------- QR rendering (vendored qrcode-generator) ---------- */
  var qrLib = null;
  function loadQrLib() {
    if (window.qrcode) return Promise.resolve(window.qrcode);
    if (!qrLib) qrLib = new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = VENDOR + "qrcode-generator/qrcode.js"; s.async = true;
      s.onload = function () { window.qrcode ? res(window.qrcode) : rej(new Error("QR library missing")); };
      s.onerror = function () { qrLib = null; rej(new Error("QR library failed to load")); };
      document.head.appendChild(s);
    });
    return qrLib;
  }
  /* renderQR(canvasOrElement, text, {size:280, ecc:'L', margin:4, dark:'#00112E', light:'#ffffff', label})
     A canvas is drawn into; any other element gets a canvas appended (replacing old content).
     Resolves to the canvas. Dark on white always - scanners need the contrast even in dark mode. */
  function renderQR(target, text, opts) {
    opts = opts || {};
    return loadQrLib().then(function (qrcode) {
      var q = qrcode(0, opts.ecc || "L");
      q.addData(String(text), "Byte");
      q.make();
      var n = q.getModuleCount(), margin = opts.margin == null ? 4 : opts.margin;
      var cells = n + margin * 2, want = opts.size || 280;
      var dpr = Math.min(window.devicePixelRatio || 1, 3);
      var cell = Math.max(2, Math.floor((want * dpr) / cells));
      var px = cell * cells;
      var canvas = target && target.tagName === "CANVAS" ? target : document.createElement("canvas");
      if (canvas !== target && target) { target.textContent = ""; target.appendChild(canvas); }
      canvas.width = px; canvas.height = px;
      canvas.style.width = Math.round(px / dpr) + "px"; canvas.style.height = Math.round(px / dpr) + "px";
      canvas.style.imageRendering = "pixelated";
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", opts.label || "Entry QR code");
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = opts.light || "#ffffff"; ctx.fillRect(0, 0, px, px);
      ctx.fillStyle = opts.dark || "#00112E";
      for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (q.isDark(r, c)) ctx.fillRect((c + margin) * cell, (r + margin) * cell, cell, cell);
      canvas.dataset.modules = String(n);
      return canvas;
    });
  }

  var API = window.AudrainPass = {
    STEP: STEP,
    ensureDeviceKey: ensureDeviceKey,
    resetDeviceKey: resetDeviceKey,
    qrString: qrString,
    badgeString: badgeString,
    verify: verify,
    renderQR: renderQR,
    secondsLeft: secondsLeft,
    currentStep: function (now) { return Math.floor(unixNow(now) / STEP); },
    /* helpers for the credential function caller and the tests */
    b64u: { encode: b64uEncode, decode: b64uDecode },
    compressPoint: compressPoint,
    decompressPoint: decompressPoint,
    thumbprint: thumbprint,
    _forceNoble: false
  };
})();
