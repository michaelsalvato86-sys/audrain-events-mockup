/* Audrain first-party attribution and events. Contract: audrain-apps/docs/2027-BUILD-CONTRACT.md.
   - First-party visitor id (localStorage) + session id (30-minute idle window, sessionStorage).
   - On landing: UTMs and click ids (fbclid, gclid, gbraid, wbraid, ttclid, msclkid) kept as first touch
     and last touch; Meta _fbp / _fbc first-party cookies (fb.1.<ms>.<value>).
   - AudrainTrack.event(name, data) -> analytics.track RPC with an event_id; the same event_id goes to any
     pixel loaded through loadPixels() so the conversions relay and the pixel de-duplicate.
   - AudrainTrack.attribution() is what checkout passes into tix.create_order.
   - Consent: an opt-out (setConsent(false)) or the browser's Global Privacy Control stops cookies,
     events and pixels. No third-party script loads unless loadPixels() is called with ids.
   Storage can throw (private mode, blocked site data): every read and write is wrapped. */
(function () {
  "use strict";
  var K = { vid: "aud_vid", attr: "aud_attr", consent: "aud_consent", sid: "aud_sid" };
  var UTM = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id"];
  var CLICK = ["fbclid", "gclid", "gbraid", "wbraid", "ttclid", "msclkid"];
  var SESSION_IDLE_MS = 30 * 60 * 1000;
  var cfg = { supabase: null, app: "concours", source: "web" };
  var queue = [];
  var pixels = { meta: false, ga: false, tiktok: false };

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }
  function jget(k) { try { return JSON.parse(lsGet(k) || "null"); } catch (e) { return null; } }
  function uuid() {
    try { if (crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
    var b = new Uint8Array(16); crypto.getRandomValues(b); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join("");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  }
  function getCookie(n) {
    try { var m = document.cookie.match(new RegExp("(?:^|; )" + n + "=([^;]*)")); return m ? decodeURIComponent(m[1]) : null; } catch (e) { return null; }
  }
  function setCookie(n, v, days) {
    try {
      var secure = location.protocol === "https:" ? "; Secure" : "";
      document.cookie = n + "=" + encodeURIComponent(v) + "; Max-Age=" + days * 86400 + "; Path=/; SameSite=Lax" + secure;
    } catch (e) {}
  }

  /* ---------- consent ---------- */
  function consented() {
    var c = lsGet(K.consent);
    if (c === "denied") return false;
    if (c === "granted") return true;
    try { if (navigator.globalPrivacyControl === true) return false; } catch (e) {}
    return true;   // US default: opt-out model; the privacy page explains how to opt out
  }
  function setConsent(granted) {
    lsSet(K.consent, granted ? "granted" : "denied");
    if (!granted) { setCookie("_fbp", "", 0); setCookie("_fbc", "", 0); }
    else capture();
  }

  /* ---------- ids ---------- */
  var memVid = null;
  function visitorId() {
    var v = lsGet(K.vid);
    if (!v) { v = memVid || uuid(); memVid = v; lsSet(K.vid, v); }
    return v;
  }
  var memSid = null;
  function sessionId() {
    var now = Date.now(), raw = ssGet(K.sid), s = null;
    try { s = JSON.parse(raw || "null"); } catch (e) {}
    if (!s && memSid) s = memSid;
    if (!s || now - s.at > SESSION_IDLE_MS) s = { id: uuid(), at: now, start: now };
    s.at = now; memSid = s; ssSet(K.sid, JSON.stringify(s));
    return s.id;
  }

  /* ---------- landing capture ---------- */
  var memAttr = null;
  function capture() {
    var q;
    try { q = new URLSearchParams(location.search); } catch (e) { return; }
    var touch = {}, any = false;
    UTM.concat(CLICK).forEach(function (k) { var v = q.get(k); if (v) { touch[k] = v.slice(0, 500); any = true; } });
    var ref = "";
    try { ref = document.referrer && new URL(document.referrer).origin !== location.origin ? document.referrer : ""; } catch (e) {}
    if (ref) { touch.referrer = ref.slice(0, 500); any = true; }
    var attr = jget(K.attr) || memAttr || {};
    if (any) {
      touch.at = new Date().toISOString();
      touch.landing = (location.origin + location.pathname).slice(0, 300);
      if (!attr.first) attr.first = touch;
      attr.last = touch;
    }
    memAttr = attr;
    if (!consented()) return;
    lsSet(K.attr, JSON.stringify(attr));
    visitorId();
    /* Meta cookies: _fbp = fb.1.<ms>.<random>; _fbc = fb.1.<ms>.<fbclid> (only when an fbclid lands). */
    if (!getCookie("_fbp")) setCookie("_fbp", "fb.1." + Date.now() + "." + Math.floor(1e9 + Math.random() * 9e9), 90);
    var fbclid = q.get("fbclid");
    if (fbclid) {
      var cur = getCookie("_fbc");
      if (!cur || cur.split(".").slice(3).join(".") !== fbclid) setCookie("_fbc", "fb.1." + Date.now() + "." + fbclid, 90);
    }
  }

  function clickIds() {
    var a = jget(K.attr) || memAttr || {}, last = a.last || {}, first = a.first || {}, out = {};
    CLICK.forEach(function (k) { var v = last[k] || first[k]; if (v) out[k] = v; });
    var fbp = getCookie("_fbp"), fbc = getCookie("_fbc");
    if (fbp) out.fbp = fbp;
    if (fbc) out.fbc = fbc;
    return out;
  }
  function utms() {
    var a = jget(K.attr) || memAttr || {}, last = a.last || {}, out = {};
    UTM.forEach(function (k) { if (last[k]) out[k] = last[k]; });
    return out;
  }

  /* What tix.create_order stores in orders.attribution. */
  function attribution() {
    if (!consented()) return { consent: false, source: cfg.source };
    var a = jget(K.attr) || memAttr || {};
    return {
      consent: true, source: cfg.source, visitor_id: visitorId(), session_id: sessionId(),
      utm: utms(), click: clickIds(), first: a.first || null, last: a.last || null,
      page: (location.origin + location.pathname).slice(0, 300)
    };
  }

  /* ---------- events ---------- */
  var PIXEL_NAMES = {
    page_view: { meta: "PageView", ga: "page_view", tt: "Pageview" },
    view_content: { meta: "ViewContent", ga: "view_item", tt: "ViewContent" },
    add_to_cart: { meta: "AddToCart", ga: "add_to_cart", tt: "AddToCart" },
    initiate_checkout: { meta: "InitiateCheckout", ga: "begin_checkout", tt: "InitiateCheckout" },
    purchase: { meta: "Purchase", ga: "purchase", tt: "CompletePayment" }
  };
  function firePixels(name, data, eventId) {
    var m = PIXEL_NAMES[name]; if (!m) return;
    var value = data.value_cents != null ? data.value_cents / 100 : undefined, currency = (data.currency || "usd").toUpperCase();
    try { if (pixels.meta && window.fbq) window.fbq("track", m.meta, value != null ? { value: value, currency: currency } : {}, { eventID: eventId }); } catch (e) {}
    try { if (pixels.ga && window.gtag) window.gtag("event", m.ga, { value: value, currency: currency, transaction_id: data.order_id, event_id: eventId }); } catch (e) {}
    try { if (pixels.tiktok && window.ttq) window.ttq.track(m.tt, value != null ? { value: value, currency: currency } : {}, { event_id: eventId }); } catch (e) {}
  }
  function send(p) {
    if (!cfg.supabase) { queue.push(p); return Promise.resolve(false); }
    try {
      return Promise.resolve(cfg.supabase.schema("analytics").rpc("track", { p_event: p }))
        .then(function (r) { return !(r && r.error); }, function () { return false; });
    } catch (e) { return Promise.resolve(false); }
  }
  /* event(name, {value_cents, currency, order_id, serial, event_id, ...}) -> event_id (string) or null when
     opted out. Browser can only record page_view, view_content, add_to_cart, initiate_checkout (server
     whitelist); purchase is written by the server and only mirrored to pixels via purchase(). */
  function event(name, data) {
    data = data || {};
    if (!consented()) return null;
    var id = data.event_id || (name + ":" + uuid());
    /* analytics.track stores browser ids as "web:<id>" and the relay sends that id, so the pixel must use it too
       or Meta / TikTok cannot de-duplicate. Server ids (purchase:<order_id>) are never prefixed. */
    if (name !== "purchase" && id.indexOf("web:") !== 0) id = "web:" + id;
    var click = clickIds(), url = (location.href || "").slice(0, 500);
    click.url = url;   // the relay reads click.url for event_source_url
    var p = {
      event_id: id, name: name, app: cfg.app, source: cfg.source, at: new Date().toISOString(),
      visitor_id: visitorId(), session_id: sessionId(), utm: utms(), click: click, consent: true,
      value_cents: data.value_cents != null ? Math.round(data.value_cents) : null, currency: data.currency || "usd",
      order_id: data.order_id || null, serial: data.serial || null,
      props: data.props || null, url: url
    };
    if (name !== "purchase") send(p);
    firePixels(name, data, id);
    return id;
  }
  /* Browser mirror of the server's purchase event: same event_id ('purchase:'||order_id) for dedup. */
  function purchase(orderId, valueCents, currency) {
    return event("purchase", { event_id: "purchase:" + orderId, order_id: orderId, value_cents: valueCents, currency: currency });
  }

  function addScript(src) { var s = document.createElement("script"); s.async = true; s.src = src; document.head.appendChild(s); }
  /* Third-party pixels load only when called with ids and consent is in place. */
  function loadPixels(ids) {
    ids = ids || {};
    if (!consented()) return false;
    if (ids.metaPixelId && !pixels.meta) {
      var f = window.fbq = window.fbq || function () { f.callMethod ? f.callMethod.apply(f, arguments) : f.queue.push(arguments); };
      if (!window._fbq) window._fbq = f;
      f.push = f; f.loaded = true; f.version = "2.0"; f.queue = f.queue || [];
      addScript("https://connect.facebook.net/en_US/fbevents.js");
      window.fbq("init", String(ids.metaPixelId));
      pixels.meta = true;
    }
    if (ids.gaId && !pixels.ga) {
      window.dataLayer = window.dataLayer || [];
      window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
      addScript("https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(ids.gaId));
      window.gtag("js", new Date());
      window.gtag("config", String(ids.gaId), { send_page_view: false });
      pixels.ga = true;
    }
    if (ids.tiktokId && !pixels.tiktok) {
      var t = window.ttq = window.ttq || [];
      ["page", "track", "identify", "instances", "debug", "on", "off", "once", "ready", "alias", "group", "enableCookie", "disableCookie"].forEach(function (m) {
        t[m] = t[m] || function () { t.push([m].concat(Array.prototype.slice.call(arguments, 0))); };
      });
      addScript("https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=" + encodeURIComponent(ids.tiktokId) + "&lib=ttq");
      pixels.tiktok = true;
    }
    return true;
  }

  function configure(o) {
    o = o || {};
    if (o.supabase) cfg.supabase = o.supabase;
    if (o.app) cfg.app = o.app;
    if (o.source) cfg.source = o.source;
    else if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) cfg.source = "app";
    var q = queue; queue = [];
    q.forEach(send);
  }

  capture();
  window.AudrainTrack = {
    configure: configure, event: event, purchase: purchase, attribution: attribution,
    pageView: function (props) { return event("page_view", { props: props }); },
    loadPixels: loadPixels, setConsent: setConsent, consented: consented,
    visitorId: function () { return consented() ? visitorId() : null; }, sessionId: sessionId,
    _capture: capture
  };
})();
