/* Audrain checkout - one call from any page or the app:
     AudrainCheckout.configure({supabase, app:'concours', functionsUrl})
     AudrainCheckout.open({items:[{ticket_type_id, qty, holder_names?}], promo, buyer:{email, name}})
       -> Promise<{status:'paid'|'free'|'cancelled'|'failed'|'not_configured', orderId, reason?, order?, pass?, pending?}>
   Flow: tix.create_order (server prices, 15-minute hold) -> checkout edge function -> pay -> poll tix.my_pass
   until the webhook has issued the tickets. The webhook is the source of truth: this file never marks an
   order paid and never fakes a ticket.
   Native app (Capacitor + @capacitor-community/stripe): PaymentSheet, which shows Apple Pay / Google Pay.
   Web: Stripe.js from js.stripe.com (the only remote script) - Express Checkout Element (Apple Pay /
   Google Pay buttons) + Payment Element in an accessible modal with the order summary and hold countdown.
   Contract: audrain-apps/docs/2027-BUILD-CONTRACT.md ("Checkout in the browser"). */
(function () {
  "use strict";
  var STRIPE_JS = "https://js.stripe.com/v3/";
  var cfg = {
    supabase: null, app: "concours", functionsUrl: "", anonKey: null, returnUrl: null,
    merchantCountry: "US", merchantDisplayName: "Audrain Concours", applePayMerchantId: null, googlePayTesting: false,
    pollMs: 2000, pollTimeoutMs: 90000
  };

  function configure(o) { o = o || {}; for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) cfg[k] = o[k]; return cfg; }
  function track(name, data) { try { if (window.AudrainTrack) return window.AudrainTrack.event(name, data); } catch (e) {} return null; }
  function money(cents, cur) {
    try { return new Intl.NumberFormat("en-US", { style: "currency", currency: (cur || "usd").toUpperCase() }).format((cents || 0) / 100); }
    catch (e) { return "$" + ((cents || 0) / 100).toFixed(2); }
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function isNative() {
    var C = window.Capacitor;
    return !!(C && C.isNativePlatform && C.isNativePlatform() && C.Plugins && C.Plugins.Stripe);
  }
  /* create_order defaults orders.channel to 'app'; the relay treats 'app' as an in-app (ATT) conversion and strips
     identifiers, so a browser checkout says 'web'. cfg.channel overrides; the native shell is always 'app'. */
  function buyerFor(b) {
    var out = {}; for (var k in (b || {})) if (Object.prototype.hasOwnProperty.call(b, k)) out[k] = b[k];
    if (!out.channel) out.channel = isNative() ? "app" : (cfg.channel || "web");
    return out;
  }
  function offlineError(e) { return !navigator.onLine || (e && /Failed to fetch|NetworkError|Load failed|network/i.test(e.message || "")); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ---------- server calls ---------- */
  function sb() { if (!cfg.supabase) throw new Error("AudrainCheckout.configure({supabase}) first"); return cfg.supabase; }
  function ensureSession() {
    var auth = sb().auth;
    return auth.getSession().then(function (r) {
      var s = r && r.data && r.data.session;
      if (s) return s;
      return auth.signInAnonymously().then(function (a) {   // guest checkout: silent account the tickets attach to
        if (a.error) throw a.error;
        return a.data.session;
      });
    });
  }
  function rpc(schema, fn, args) {
    return Promise.resolve(sb().schema(schema).rpc(fn, args)).then(function (r) {
      if (r.error) { var e = new Error(r.error.message || "Request failed"); e.code = r.error.code; e.raw = r.error; throw e; }
      return r.data;
    });
  }
  function callFunction(name, body) {
    return ensureSession().then(function (s) {
      var url = cfg.functionsUrl.replace(/\/$/, "") + "/" + name;
      var headers = { "Content-Type": "application/json", Authorization: "Bearer " + s.access_token };
      var key = cfg.anonKey || sb().supabaseKey;
      if (key) headers.apikey = key;
      return fetch(url, { method: "POST", headers: headers, body: JSON.stringify(body) }).then(function (res) {
        return res.text().then(function (t) {
          var j = null; try { j = JSON.parse(t); } catch (e) {}
          if (!res.ok) { var err = new Error((j && (j.message || j.error)) || ("HTTP " + res.status)); err.status = res.status; err.code = j && j.error; err.body = j; throw err; }
          return j || {};
        });
      });
    });
  }
  /* Polls tix.my_pass until tickets for orderId appear. Resolves {found, pass}. */
  function waitForTickets(orderId) {
    var start = Date.now();
    function hasOrder(p) {
      var list = (p && (p.tickets || (p.pass && p.pass.tickets))) || [];
      return list.some(function (t) { return t && (t.order_id === orderId); });
    }
    function once() {
      return rpc("tix", "my_pass", { p_app: cfg.app }).then(function (p) { return p; }, function () { return null; }).then(function (p) {
        if (hasOrder(p)) return { found: true, pass: p };
        if (Date.now() - start > cfg.pollTimeoutMs) return { found: false, pass: p };
        return sleep(cfg.pollMs).then(once);
      });
    }
    return once();
  }

  /* ---------- Stripe.js loader ---------- */
  var stripeLoad = null;
  function loadStripe() {
    if (window.Stripe) return Promise.resolve(window.Stripe);
    if (!stripeLoad) stripeLoad = new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = STRIPE_JS; s.async = true;
      s.onload = function () { window.Stripe ? res(window.Stripe) : rej(new Error("Stripe did not load")); };
      s.onerror = function () { stripeLoad = null; var e = new Error("Failed to fetch Stripe"); rej(e); };
      document.head.appendChild(s);
    });
    return stripeLoad;
  }

  /* ---------- modal ---------- */
  var CSS = ".acx-back{position:fixed;inset:0;z-index:1000;background:rgba(0,17,46,.62);display:flex;align-items:flex-end;justify-content:center}" +
    "@media (min-width:600px){.acx-back{align-items:center}}" +
    ".acx{background:var(--surface,#fffdf8);color:var(--fg,#14213a);width:100%;max-width:480px;max-height:92vh;overflow:auto;border-radius:16px 16px 0 0;padding:20px 16px calc(20px + env(safe-area-inset-bottom,0px));box-shadow:0 -8px 40px rgba(0,0,0,.3);font-family:var(--body,system-ui,sans-serif)}" +
    "@media (min-width:600px){.acx{border-radius:16px}}" +
    ".acx h2{font-family:var(--display,'Arial Narrow',sans-serif);text-transform:uppercase;letter-spacing:.03em;font-size:24px;margin:0 0 4px}" +
    ".acx-top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}" +
    ".acx-x{border:1px solid var(--line,#e3dccb);background:transparent;border-radius:999px;min-width:44px;min-height:44px;font-size:20px;line-height:1;color:inherit;cursor:pointer}" +
    ".acx-sum{width:100%;border-collapse:collapse;margin:12px 0;font-size:14px}.acx-sum td{padding:5px 0;vertical-align:top}.acx-sum td:last-child{text-align:right;white-space:nowrap;padding-left:12px}" +
    ".acx-sum tr.acx-tot td{border-top:1px solid var(--line,#e3dccb);font-weight:700;font-size:16px;padding-top:9px}" +
    ".acx-hold{font-size:13px;color:var(--muted,#5d6678);margin:0 0 12px}.acx-hold b{font-variant-numeric:tabular-nums;color:var(--fg,#14213a)}" +
    ".acx-pay{display:block;width:100%;min-height:48px;margin-top:14px;border:0;border-radius:12px;background:var(--btn,#003057);color:var(--btn-fg,#f7f0de);font-weight:700;font-size:16px;cursor:pointer}" +
    ".acx-pay[disabled]{opacity:.55;cursor:not-allowed}" +
    ".acx-2nd{display:block;width:100%;min-height:44px;margin-top:10px;border:1px solid var(--line,#e3dccb);border-radius:12px;background:transparent;color:inherit;font-weight:600;cursor:pointer}" +
    ".acx-err{color:#a33a2b;font-weight:600;font-size:14px;margin:10px 0 0}" +
    "@media (prefers-color-scheme:dark){:root:not([data-theme=light]) .acx-err{color:#ff9d8f}}:root[data-theme=dark] .acx-err{color:#ff9d8f}" +
    ".acx-or{display:flex;align-items:center;gap:10px;color:var(--muted,#5d6678);font-size:12px;margin:14px 0}.acx-or:before,.acx-or:after{content:'';flex:1;border-top:1px solid var(--line,#e3dccb)}" +
    ".acx-msg{font-size:15px;margin:10px 0}.acx-spin{width:28px;height:28px;border:3px solid var(--line,#e3dccb);border-top-color:var(--gold,#DBAB1A);border-radius:50%;animation:acxs 0.9s linear infinite;margin:18px auto}" +
    "@keyframes acxs{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.acx-spin{animation:none}}" +
    ".acx-fine{font-size:12px;color:var(--muted,#5d6678);margin-top:12px}";
  function injectCss() {
    if (document.getElementById("acx-css")) return;
    var st = document.createElement("style"); st.id = "acx-css"; st.textContent = CSS; document.head.appendChild(st);
  }

  function Modal(onClose) {
    injectCss();
    var self = this;
    this.prevFocus = document.activeElement;
    this.back = document.createElement("div");
    this.back.className = "acx-back";
    this.box = document.createElement("div");
    this.box.className = "acx";
    this.box.setAttribute("role", "dialog");
    this.box.setAttribute("aria-modal", "true");
    this.box.setAttribute("aria-labelledby", "acx-title");
    this.back.appendChild(this.box);
    this.hidden = [];
    Array.prototype.forEach.call(document.body.children, function (el) {
      if (el.tagName !== "SCRIPT" && !el.inert) { el.inert = true; el.setAttribute("aria-hidden", "true"); self.hidden.push(el); }
    });
    document.body.appendChild(this.back);
    this.locked = false;
    this.onKey = function (e) {
      if (e.key === "Escape" && !self.locked) { e.preventDefault(); onClose(); }
      if (e.key !== "Tab") return;
      var f = self.focusables();
      if (!f.length) { e.preventDefault(); return; }
      /* Move focus ourselves: Safari skips buttons and links on Tab by default, which would let focus
         fall out of the dialog. Stripe's iframes are in the list, so Tab still reaches the card fields. */
      e.preventDefault();
      var i = f.indexOf(document.activeElement);
      var next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i === -1 || i === f.length - 1 ? 0 : i + 1);
      f[next].focus();
    };
    document.addEventListener("keydown", this.onKey, true);
    this.back.addEventListener("mousedown", function (e) { if (e.target === self.back && !self.locked) onClose(); });
    this.onClose = onClose;
  }
  Modal.prototype.focusables = function () {
    return Array.prototype.filter.call(this.box.querySelectorAll("button,[href],input,select,textarea,iframe,[tabindex]:not([tabindex='-1'])"),
      function (el) { return !el.disabled && el.offsetParent !== null; });
  };
  Modal.prototype.render = function (html, focusSel) {
    var self = this;
    this.box.innerHTML = '<div class="acx-top"><h2 id="acx-title" tabindex="-1"></h2>' +
      '<button type="button" class="acx-x" aria-label="Close checkout">&times;</button></div><div class="acx-body"></div>' +
      '<div class="acx-live" role="status" aria-live="polite" style="position:absolute;left:-9999px"></div>';
    this.box.querySelector(".acx-body").innerHTML = html.body;
    this.box.querySelector("#acx-title").textContent = html.title;
    this.box.dataset.state = html.state;
    var x = this.box.querySelector(".acx-x");
    x.hidden = !!this.locked;
    x.addEventListener("click", function () { if (!self.locked) self.onClose(); });
    this.announce(html.announce || html.title);
    var target = (focusSel && this.box.querySelector(focusSel)) || this.box.querySelector("#acx-title");
    setTimeout(function () { try { target.focus(); } catch (e) {} }, 0);
    return this.box;
  };
  Modal.prototype.announce = function (t) { var l = this.box.querySelector(".acx-live"); if (l) l.textContent = t; };
  Modal.prototype.close = function () {
    document.removeEventListener("keydown", this.onKey, true);
    this.hidden.forEach(function (el) { el.inert = false; el.removeAttribute("aria-hidden"); });
    if (this.back.parentNode) this.back.parentNode.removeChild(this.back);
    try { if (this.prevFocus && this.prevFocus.focus) this.prevFocus.focus(); } catch (e) {}
  };

  function summaryHtml(o) {
    var cur = o.currency || "usd", rows = "";
    (o.lines || []).forEach(function (l) {
      rows += "<tr><td>" + esc(l.name) + " &times; " + esc(l.qty) + "</td><td>" + money(l.unit_cents * l.qty, cur) + "</td></tr>";
    });
    rows += "<tr><td>Subtotal</td><td>" + money(o.subtotal_cents, cur) + "</td></tr>";
    if (o.discount_cents) rows += "<tr><td>Discount</td><td>&minus;" + money(o.discount_cents, cur) + "</td></tr>";
    if (o.fees_cents) rows += "<tr><td>Service fees</td><td>" + money(o.fees_cents, cur) + "</td></tr>";
    rows += "<tr><td>Tax</td><td>" + money(o.tax_cents, cur) + "</td></tr>";
    rows += '<tr class="acx-tot"><td>Total</td><td data-acx-total>' + money(o.total_cents, cur) + "</td></tr>";
    return '<table class="acx-sum"><caption style="position:absolute;left:-9999px">Order summary</caption><tbody>' + rows + "</tbody></table>";
  }
  function holdHtml(o) {
    return o.expires_at ? '<p class="acx-hold">Tickets held for <b data-acx-hold aria-live="off">15:00</b>. Complete payment before the hold ends.</p>' : "";
  }

  /* ---------- the flow ---------- */
  function open(req) {
    req = req || {};
    var items = (req.items || []).filter(function (i) { return i && i.ticket_type_id && i.qty > 0; });
    var finished = false, modal = null, order = null, holdTimer = null, stripeEls = null;
    var resolveFn;
    var done = new Promise(function (r) { resolveFn = r; });
    function finish(res) {
      if (finished) return; finished = true;
      clearInterval(holdTimer);
      try { if (stripeEls && stripeEls.destroy) stripeEls.destroy(); } catch (e) {}
      if (modal) modal.close();
      res.orderId = res.orderId || (order && order.order_id) || null;
      if (order && !res.order) res.order = order;
      resolveFn(res);
    }
    var cancel = function () { finish({ status: "cancelled" }); };
    modal = new Modal(function () { cancel(); });

    function working(title, msg) {
      modal.render({ state: "working", title: title, body: '<div class="acx-spin" aria-hidden="true"></div><p class="acx-msg">' + esc(msg || "") + "</p>" });
    }
    function stateScreen(state, title, msg, buttons) {
      var b = '<p class="acx-msg">' + msg + "</p>";
      (buttons || []).forEach(function (btn, i) { b += '<button type="button" class="' + (i ? "acx-2nd" : "acx-pay") + '" data-acx-btn="' + i + '">' + esc(btn.label) + "</button>"; });
      var box = modal.render({ state: state, title: title, body: b }, '[data-acx-btn="0"]');
      (buttons || []).forEach(function (btn, i) { box.querySelector('[data-acx-btn="' + i + '"]').addEventListener("click", btn.run); });
    }
    function offline(retry) {
      modal.locked = false;
      stateScreen("offline", "You're offline", "We couldn't reach the box office. Check your connection and try again - your tickets stay on hold until the timer runs out.",
        [{ label: "Try again", run: retry }, { label: "Cancel", run: cancel }]);
    }
    function soon() {
      modal.locked = false;
      stateScreen("not_configured", "Payments open soon", "Online payment for the 2027 Concours isn't switched on yet. Nothing has been charged. Please check back soon.",
        [{ label: "Close", run: function () { finish({ status: "not_configured" }); } }]);
    }
    function expired() {
      modal.locked = false; clearInterval(holdTimer);
      stateScreen("hold_expired", "Your hold ended", "The 15-minute hold on these tickets ran out, so they went back on sale. Nothing was charged. Start again to check availability.",
        [{ label: "Start over", run: function () { finish({ status: "failed", reason: "hold_expired" }); } }]);
    }
    function failed(msg, reason) {
      modal.locked = false;
      stateScreen("error", "We couldn't complete that", esc(msg || "Something went wrong."), [{ label: "Close", run: function () { finish({ status: "failed", reason: reason || "error", message: msg }); } }]);
    }
    function startHoldTimer() {
      if (!order || !order.expires_at) return;
      var end = new Date(order.expires_at).getTime();
      var tick = function () {
        var left = Math.max(0, Math.round((end - Date.now()) / 1000));
        var el = modal.box.querySelector("[data-acx-hold]");
        if (el) el.textContent = Math.floor(left / 60) + ":" + ("0" + (left % 60)).slice(-2);
        if (left === 0 && !modal.locked) expired();
        if (left === 60) modal.announce("One minute left on your ticket hold");
      };
      clearInterval(holdTimer); tick(); holdTimer = setInterval(tick, 1000);
    }

    function afterPayment(kind) {
      modal.locked = true;
      working(kind === "free" ? "Issuing your tickets" : "Payment received", "Issuing your tickets - this usually takes a few seconds.");
      clearInterval(holdTimer);
      if (kind !== "free" && window.AudrainTrack) try { window.AudrainTrack.purchase(order.order_id, order.total_cents, order.currency); } catch (e) {}
      return waitForTickets(order.order_id).then(function (r) {
        modal.locked = false;
        finish({ status: kind, pass: r.pass, pending: !r.found });
      });
    }

    /* step 1: create the order (server prices and holds) */
    function createOrder() {
      if (!navigator.onLine) return offline(createOrder);
      working("Checking availability", "Holding your tickets...");
      var attribution = null;
      try { attribution = window.AudrainTrack ? window.AudrainTrack.attribution() : null; } catch (e) {}
      ensureSession().then(function () {
        return rpc("tix", "create_order", {
          p_app: cfg.app, p_items: items, p_promo: req.promo ? String(req.promo).trim() : null,
          p_attribution: attribution, p_buyer: buyerFor(req.buyer)
        });
      }).then(function (o) {
        if (finished) return;
        order = o;
        track("initiate_checkout", { value_cents: o.total_cents, currency: o.currency, order_id: o.order_id });
        if (!o.total_cents) {
          return rpc("tix", "finalize_free_order", { p_order_id: o.order_id }).then(function () { return afterPayment("free"); });
        }
        return startPayment();
      }).catch(function (e) {
        if (finished) return;
        if (offlineError(e)) return offline(createOrder);
        failed(e.message, "create_order");
      });
    }

    /* step 2: payment intent from the checkout function */
    function startPayment() {
      if (!navigator.onLine) return offline(startPayment);
      working("Secure checkout", "Connecting to our payment provider...");
      return callFunction("checkout", { order_id: order.order_id, platform: isNative() ? "payment_sheet" : "web" }).then(function (pi) {
        if (finished) return;
        return isNative() ? payNative(pi) : payWeb(pi);
      }).catch(function (e) {
        if (finished) return;
        if (e.status === 503 || e.code === "not_configured") return soon();
        if (e.code === "hold_expired" || e.code === "expired" || e.status === 410) return expired();
        if (e.code === "not_pending" || e.code === "already_paid") return afterPayment("paid");
        if (offlineError(e)) return offline(startPayment);
        failed(e.message, "checkout");
      });
    }

    /* native: @capacitor-community/stripe PaymentSheet */
    function payNative(pi) {
      var S = window.Capacitor.Plugins.Stripe;
      working("Secure checkout", "Opening payment sheet...");
      return Promise.resolve(S.initialize({ publishableKey: pi.publishableKey })).then(function () {
        return S.createPaymentSheet({
          paymentIntentClientSecret: pi.clientSecret,
          customerId: pi.customer, customerEphemeralKeySecret: pi.ephemeralKey,
          merchantDisplayName: pi.merchantDisplayName || cfg.merchantDisplayName,
          enableApplePay: true, applePayMerchantId: cfg.applePayMerchantId || undefined,
          enableGooglePay: true, GooglePayIsTesting: !!cfg.googlePayTesting,
          countryCode: cfg.merchantCountry, merchantCountryCode: cfg.merchantCountry,
          currencyCode: (pi.currency || order.currency || "usd").toUpperCase()
        });
      }).then(function () { return S.presentPaymentSheet(); }).then(function (r) {
        var res = (r && (r.paymentResult || r)) || "";
        if (/Completed/i.test(res)) return afterPayment("paid");
        if (/Canceled|Cancelled/i.test(res)) return finish({ status: "cancelled", reason: "sheet_cancelled" });
        failed("Your payment didn't go through. You have not been charged.", "payment_failed");
      }).catch(function (e) { if (offlineError(e)) return offline(startPayment); failed(e.message || "Payment failed", "payment_failed"); });
    }

    /* web: Stripe.js Express Checkout + Payment Element */
    function payWeb(pi) {
      return loadStripe().then(function (StripeFn) {
        if (finished) return;
        var stripe = StripeFn(pi.publishableKey);
        var cs = getComputedStyle(document.documentElement);
        var elements = stripe.elements({
          clientSecret: pi.clientSecret,
          appearance: { theme: "stripe", variables: { colorPrimary: (cs.getPropertyValue("--navy") || "#003057").trim(), borderRadius: "10px", fontFamily: "Figtree, system-ui, sans-serif" } }
        });
        stripeEls = { destroy: function () { try { express.destroy(); payment.destroy(); } catch (e) {} } };
        var box = modal.render({
          state: "pay", title: "Checkout", announce: "Checkout. Total " + money(order.total_cents, order.currency),
          body: summaryHtml(order) + holdHtml(order) +
            '<div data-acx-express aria-label="Express checkout"></div>' +
            '<div class="acx-or" data-acx-or>or pay with card</div>' +
            '<div data-acx-payment></div>' +
            '<p class="acx-err" data-acx-err role="alert" hidden></p>' +
            '<button type="button" class="acx-pay" data-acx-paybtn>Pay ' + money(order.total_cents, order.currency) + "</button>" +
            '<p class="acx-fine">Payments are processed by Stripe. Statement shows AUDRAIN CONCOURS. All sales are subject to the <a href="' + esc(cfg.termsUrl || "terms.html") + '" target="_blank" rel="noopener">terms</a> and <a href="' + esc(cfg.refundUrl || "refund.html") + '" target="_blank" rel="noopener">refund policy</a>.</p>'
        }, "[data-acx-paybtn]");
        startHoldTimer();
        var errEl = box.querySelector("[data-acx-err]"), payBtn = box.querySelector("[data-acx-paybtn]");
        var express = elements.create("expressCheckout", { buttonType: { applePay: "buy", googlePay: "buy" } });
        var payment = elements.create("payment", {
          layout: "tabs",
          defaultValues: req.buyer ? { billingDetails: { email: req.buyer.email || "", name: req.buyer.name || "" } } : undefined
        });
        express.mount(box.querySelector("[data-acx-express]"));
        payment.mount(box.querySelector("[data-acx-payment]"));
        if (express.on) express.on("ready", function (ev) {
          var m = ev && ev.availablePaymentMethods;
          if (!m || !Object.keys(m).some(function (k) { return m[k]; })) {
            box.querySelector("[data-acx-express]").hidden = true; box.querySelector("[data-acx-or]").hidden = true;
          }
        });
        function showErr(msg) { errEl.textContent = msg; errEl.hidden = false; modal.announce(msg); }
        function confirm(expressEvent) {
          if (modal.locked) return;
          errEl.hidden = true;
          if (!navigator.onLine) { showErr("You're offline. Reconnect and tap Pay again - nothing has been charged."); return; }
          if (order.expires_at && new Date(order.expires_at).getTime() <= Date.now()) return expired();
          modal.locked = true; payBtn.disabled = true; payBtn.textContent = "Processing...";
          var pre = expressEvent ? Promise.resolve({}) : Promise.resolve(elements.submit ? elements.submit() : {});
          return pre.then(function (sub) {
            if (sub && sub.error) return { error: sub.error };
            return stripe.confirmPayment({
              elements: elements,
              confirmParams: {
                return_url: cfg.returnUrl || (location.origin + location.pathname + "?order_id=" + encodeURIComponent(order.order_id)),
                receipt_email: req.buyer && req.buyer.email ? req.buyer.email : undefined
              },
              redirect: "if_required"
            });
          }).then(function (r) {
            if (r && r.error) {
              modal.locked = false; payBtn.disabled = false; payBtn.textContent = "Pay " + money(order.total_cents, order.currency);
              if (expressEvent && expressEvent.paymentFailed) try { expressEvent.paymentFailed({ reason: "fail" }); } catch (e) {}
              var e = r.error;
              if (e.type === "card_error") return showErr((e.message || "Your card was declined.") + " You have not been charged.");
              if (e.type === "validation_error") return showErr(e.message || "Check your payment details.");
              if (offlineError(e)) return showErr("Connection lost. Nothing has been charged - try again.");
              return showErr(e.message || "Payment failed. You have not been charged.");
            }
            var st = r && r.paymentIntent && r.paymentIntent.status;
            if (st === "succeeded" || st === "processing" || st === "requires_capture") return afterPayment("paid");
            modal.locked = false; payBtn.disabled = false;
            showErr("Payment wasn't completed. You have not been charged.");
          }).catch(function (e) {
            modal.locked = false; payBtn.disabled = false; payBtn.textContent = "Pay " + money(order.total_cents, order.currency);
            showErr(offlineError(e) ? "Connection lost. Nothing has been charged - try again." : (e.message || "Payment failed."));
          });
        }
        if (express.on) express.on("confirm", function (ev) { confirm(ev || {}); });
        payBtn.addEventListener("click", function () { confirm(null); });
      }).catch(function (e) {
        if (finished) return;
        if (offlineError(e)) return offline(startPayment);
        failed(e.message, "stripe_js");
      });
    }

    if (!items.length) { finish({ status: "failed", reason: "empty_cart" }); return done; }
    createOrder();
    return done;
  }

  /* After a redirect-based payment method returns to the page (?order_id=...&redirect_status=...). */
  function resume(orderId) {
    return waitForTickets(orderId).then(function (r) { return { status: "paid", orderId: orderId, pass: r.pass, pending: !r.found }; });
  }

  /* callFunction(name, body) - POST to an edge function with the caller's JWT (used for `credential` too). */
  window.AudrainCheckout = { configure: configure, open: open, resume: resume, waitForTickets: waitForTickets, callFunction: callFunction, ensureSession: ensureSession, _isNative: isNative };
})();
