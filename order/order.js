/* Audrain Concours ordering site (future tickets.audrainconcours.com).
   Reads tix.catalog, builds a cart within the server's rules (per_order_max, remaining, sales window,
   add-ons need a ticket), collects holder names + buyer, then hands off to AudrainCheckout. The server
   re-prices and re-checks everything; the client rules are only there so people don't hit avoidable errors.
   Guest checkout: a silent anonymous Supabase session is created at checkout, not on page load.
   Prices are all-in from the first view (FTC junk-fee rule): price + mandatory per-ticket fee. */
(function () {
  "use strict";
  var CFG = window.ORDER_CONFIG || {};
  var PARENT_KINDS = { ticket: 1, admission: 1, membership: 1 };   // kinds that satisfy requires_parent
  var NAMED_KINDS = { ticket: 1, admission: 1 };                    // one holder name per unit
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var state = { events: [], types: {}, cart: {}, names: {}, loaded: false };
  var client = null;

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function money(c, cur) {
    try { return new Intl.NumberFormat("en-US", { style: "currency", currency: (cur || "usd").toUpperCase() }).format((c || 0) / 100); }
    catch (e) { return "$" + ((c || 0) / 100).toFixed(2); }
  }
  function say(t) { var l = $("#live"); l.textContent = ""; setTimeout(function () { l.textContent = t; }, 30); }
  function fmtDay(iso) { return new Intl.DateTimeFormat("en-US", { timeZone: CFG.tz || "America/New_York", weekday: "long", month: "long", day: "numeric" }).format(new Date(iso)); }
  function dayKey(iso) { return new Intl.DateTimeFormat("en-CA", { timeZone: CFG.tz || "America/New_York" }).format(new Date(iso)); }
  function fmtTime(iso) { return new Intl.DateTimeFormat("en-US", { timeZone: CFG.tz || "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date(iso)); }

  /* ---------- views ---------- */
  var VIEWS = ["shop", "details", "done", "lookup"];
  function show(v, focus) {
    VIEWS.forEach(function (n) { $("#v-" + n).hidden = n !== v; });
    $("#cartbar").hidden = v !== "shop" || cartCount() === 0;
    window.scrollTo(0, 0);
    var h = $("#v-" + v + " h1");
    if (focus !== false && h) { h.setAttribute("tabindex", "-1"); h.focus(); }
  }
  document.addEventListener("click", function (e) {
    var g = e.target.closest && e.target.closest("[data-go]");
    if (!g) return;
    e.preventDefault();
    show(g.getAttribute("data-go"));
  });

  /* ---------- catalog ---------- */
  function normalize(raw) {
    var evs = Array.isArray(raw) ? raw : (raw && (raw.events || raw.items)) || [];
    var types = {};
    evs.forEach(function (ev) {
      ev.ticket_types = ev.ticket_types || ev.types || [];
      ev.ticket_types.forEach(function (t) {
        t.event_id = t.event_id || ev.id; t._event = ev;
        t.kind = t.kind || "ticket";
        t.fee_cents = t.fee_cents || 0;
        t.allin_cents = (t.price_cents || 0) + t.fee_cents;
        types[t.id] = t;
      });
      ev.ticket_types.sort(function (a, b) { return (a.requires_parent ? 1 : 0) - (b.requires_parent ? 1 : 0) || (a.sort || 0) - (b.sort || 0); });
    });
    evs.sort(function (a, b) { return String(a.starts_at || "9").localeCompare(String(b.starts_at || "9")); });
    return { events: evs, types: types };
  }
  function saleState(t, now) {
    now = now || Date.now();
    if (t._event && t._event.sold_in_app === false) return "external";
    if (t.sales_start && new Date(t.sales_start).getTime() > now) return "soon";
    if (t.sales_end && new Date(t.sales_end).getTime() < now) return "closed";
    if (t.remaining != null && t.remaining <= 0) return "sold_out";
    return "on";
  }
  function maxFor(t) {
    var m = t.per_order_max == null ? 10 : t.per_order_max;
    if (t.remaining != null) m = Math.min(m, t.remaining);
    return Math.max(0, m);
  }
  function hasParent() {
    return Object.keys(state.cart).some(function (id) { var t = state.types[id]; return t && state.cart[id] > 0 && !t.requires_parent && PARENT_KINDS[t.kind]; });
  }
  function cartCount() { return Object.keys(state.cart).reduce(function (s, id) { return s + (state.cart[id] || 0); }, 0); }
  function cartTotal() { return Object.keys(state.cart).reduce(function (s, id) { var t = state.types[id]; return s + (t ? t.allin_cents * state.cart[id] : 0); }, 0); }
  function saveCart() { ssSet("aud_order_cart", JSON.stringify({ cart: state.cart, names: state.names })); }

  function renderCatalog() {
    var box = $("#catalog");
    box.setAttribute("aria-busy", "false");
    if (!state.events.length) { box.innerHTML = '<p class="notice">2027 tickets are not on sale yet. Check back soon.</p>'; return; }
    var days = [], byDay = {};
    state.events.forEach(function (ev) {
      var k = ev.starts_at ? dayKey(ev.starts_at) : "zz";
      if (!byDay[k]) { byDay[k] = []; days.push(k); }
      byDay[k].push(ev);
    });
    days.sort();
    var html = "";
    days.forEach(function (k) {
      var first = byDay[k][0];
      html += '<section class="day" aria-labelledby="day-' + k + '"><h2 id="day-' + k + '">' +
        (k === "zz" ? "<span>Any day</span>Passes and extras" : "<span>" + esc(fmtDay(first.starts_at).split(",")[0]) + "</span>" + esc(fmtDay(first.starts_at).split(", ").slice(1).join(", "))) + "</h2>";
      byDay[k].forEach(function (ev) {
        html += '<article class="ev" aria-labelledby="ev-' + esc(ev.id) + '">' + (ev.image_url ? '<img src="' + esc(ev.image_url) + '" alt="">' : "") +
          '<div class="ev-h"><h3 id="ev-' + esc(ev.id) + '">' + esc(ev.title) + '</h3><div class="ev-meta">' +
          [ev.starts_at ? fmtTime(ev.starts_at) + (ev.ends_at ? " - " + fmtTime(ev.ends_at) : "") : "", ev.venue || ""].filter(Boolean).map(esc).join(" &middot; ") +
          "</div>" + (ev.description ? '<p class="ev-desc">' + esc(ev.description) + "</p>" : "") + "</div>";
        ev.ticket_types.forEach(function (t) { html += typeRow(t); });
        html += "</article>";
      });
      html += "</section>";
    });
    box.innerHTML = html;
    refreshSteppers();
  }
  function typeRow(t) {
    var st = saleState(t), cur = t.currency;
    var price = '<div class="tt-price">' + (t.allin_cents ? money(t.allin_cents, cur) : "Free") +
      (t.fee_cents ? ' <small>incl. ' + money(t.fee_cents, cur) + " fee</small>" : "") +
      (t.tax_rate_bp ? ' <small>+ tax</small>' : "") + "</div>";
    var note = "";
    if (st === "soon") note = '<div class="tt-state">On sale ' + esc(fmtDay(t.sales_start)) + " at " + esc(fmtTime(t.sales_start)) + "</div>";
    else if (st === "closed") note = '<div class="tt-state out">Sales closed</div>';
    else if (st === "sold_out") note = '<div class="tt-state out">Sold out</div>';
    else if (t.remaining != null && t.remaining <= 20) note = '<div class="tt-state low">Only ' + t.remaining + " left</div>";
    if (t.requires_parent) note += '<div class="tt-desc" data-parent-note="' + esc(t.id) + '">Add-on: needs a ticket in this order.</div>';
    var ctl;
    if (st === "external") ctl = t._event.external_url ? '<a class="ext" href="' + esc(t._event.external_url) + '" rel="noopener" target="_blank">Buy from partner<span class="sr"> (opens new tab)</span></a>' : "";
    else ctl = '<div class="step" role="group" aria-label="Quantity, ' + esc(t.name) + '">' +
      '<button type="button" data-dec="' + esc(t.id) + '" aria-label="Remove one ' + esc(t.name) + '">&minus;</button>' +
      '<output data-qty="' + esc(t.id) + '" aria-live="polite">0</output>' +
      '<button type="button" data-inc="' + esc(t.id) + '" aria-label="Add one ' + esc(t.name) + '">+</button></div>';
    return '<div class="tt" data-type="' + esc(t.id) + '"><div class="tt-info"><div class="tt-name">' + esc(t.name) +
      (t.kind !== "ticket" ? '<span class="tt-kind">' + esc(t.kind) + "</span>" : "") + "</div>" +
      (t.description ? '<div class="tt-desc">' + esc(t.description) + "</div>" : "") + price + note + "</div>" + ctl + "</div>";
  }
  function refreshSteppers() {
    var parent = hasParent();
    Object.keys(state.types).forEach(function (id) {
      var t = state.types[id], q = state.cart[id] || 0, st = saleState(t);
      var out = document.querySelector('[data-qty="' + id + '"]');
      if (!out) return;
      out.textContent = q;
      var inc = document.querySelector('[data-inc="' + id + '"]'), dec = document.querySelector('[data-dec="' + id + '"]');
      inc.disabled = st !== "on" || q >= maxFor(t) || (t.requires_parent && !parent);
      dec.disabled = q <= 0;
      var pn = document.querySelector('[data-parent-note="' + id + '"]');
      if (pn) pn.textContent = parent ? "Add-on: attaches to the tickets in this order." : "Add-on: add a ticket first.";
    });
    var n = cartCount();
    $("#cartbar").hidden = n === 0 || $("#v-shop").hidden;
    $("#cart-total").textContent = money(cartTotal());
    $("#cart-count").textContent = n + (n === 1 ? " item" : " items") + ", fees included";
    var problem = cartProblem();
    $("#cart-go").disabled = !!problem;
    $("#cart-go").setAttribute("aria-describedby", "cart-count");
    if (problem) $("#cart-count").textContent = problem;
  }
  function cartProblem() {
    var addonOnly = Object.keys(state.cart).some(function (id) { var t = state.types[id]; return t && state.cart[id] > 0 && t.requires_parent; }) && !hasParent();
    if (addonOnly) return "Add-ons need a ticket in the same order";
    return null;
  }
  function changeQty(id, d) {
    var t = state.types[id]; if (!t) return;
    var q = Math.max(0, Math.min(maxFor(t), (state.cart[id] || 0) + d));
    if (d > 0 && t.requires_parent && !hasParent()) return;
    if (q === (state.cart[id] || 0)) return;
    if (q) state.cart[id] = q; else delete state.cart[id];
    if (d > 0 && window.AudrainTrack) AudrainTrack.event("add_to_cart", { value_cents: t.allin_cents, currency: t.currency, props: { ticket_type_id: id } });
    saveCart();
    refreshSteppers();
    say(t.name + ": " + q + " in cart. Total " + money(cartTotal()));
    var p = cartProblem(); if (p) say(p);
  }
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-inc],[data-dec]");
    if (!b || b.disabled) return;
    changeQty(b.getAttribute("data-inc") || b.getAttribute("data-dec"), b.hasAttribute("data-inc") ? 1 : -1);
  });

  /* ---------- details ---------- */
  function items() {
    return Object.keys(state.cart).filter(function (id) { return state.cart[id] > 0; }).map(function (id) {
      var t = state.types[id], it = { ticket_type_id: id, qty: state.cart[id] };
      if (NAMED_KINDS[t.kind]) it.holder_names = (state.names[id] || []).slice(0, it.qty).map(function (s) { return String(s || "").trim(); });
      return it;
    });
  }
  function renderDetails() {
    var html = "<h2>Guest names</h2>", any = false;
    Object.keys(state.cart).forEach(function (id) {
      var t = state.types[id]; if (!t || !NAMED_KINDS[t.kind]) return;
      var names = state.names[id] = state.names[id] || [];
      for (var i = 0; i < state.cart[id]; i++) {
        any = true;
        html += '<label class="field"><span>' + esc(t.name) + " - guest " + (i + 1) + '</span><input required autocomplete="' + (i === 0 ? "name" : "off") +
          '" data-holder="' + esc(id) + '" data-idx="' + i + '" value="' + esc(names[i] || "") + '"></label>';
      }
    });
    $("#holders").innerHTML = any ? html : "<h2>Guest names</h2><p>No named tickets in this order.</p>";
    var rows = "", tax = 0, cur = "usd";
    Object.keys(state.cart).forEach(function (id) {
      var t = state.types[id]; cur = t.currency || cur;
      rows += "<tr><td>" + esc(t.name) + " &times; " + state.cart[id] + "</td><td>" + money(t.allin_cents * state.cart[id], cur) + "</td></tr>";
      tax += Math.round((t.price_cents || 0) * (t.tax_rate_bp || 0) / 10000) * state.cart[id];
    });
    if (tax) rows += "<tr><td>Estimated tax</td><td>" + money(tax, cur) + "</td></tr>";
    rows += '<tr class="tot"><td>Estimated total</td><td>' + money(cartTotal() + tax, cur) + "</td></tr>";
    $("#est tbody").innerHTML = rows;
    var saved = {}; try { saved = JSON.parse(lsGet("aud_order_buyer") || "{}") || {}; } catch (e) {}
    if (!$("#b-name").value && saved.name) $("#b-name").value = saved.name;
    if (!$("#b-email").value && saved.email) $("#b-email").value = saved.email;
  }
  document.addEventListener("input", function (e) {
    var h = e.target.getAttribute && e.target.getAttribute("data-holder");
    if (h) { (state.names[h] = state.names[h] || [])[+e.target.getAttribute("data-idx")] = e.target.value; saveCart(); }
    if (e.target.getAttribute && e.target.getAttribute("aria-invalid") === "true") { e.target.removeAttribute("aria-invalid"); }
  });
  $("#cart-go").addEventListener("click", function () { if (cartProblem()) return; renderDetails(); show("details"); });

  function validEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s); }
  function validate() {
    var bad = [];
    document.querySelectorAll("#details input[required]").forEach(function (inp) {
      var v = inp.value.trim(), ok = v && (inp.type !== "email" || validEmail(v));
      inp.setAttribute("aria-invalid", ok ? "false" : "true");
      if (!ok) bad.push(inp);
    });
    return bad;
  }
  $("#details").addEventListener("submit", function (e) {
    e.preventDefault();
    var bad = validate(), err = $("#det-err");
    if (bad.length) { err.textContent = "Please complete the highlighted fields (" + bad.length + ")."; err.hidden = false; bad[0].focus(); return; }
    err.hidden = true;
    var buyer = { email: $("#b-email").value.trim().toLowerCase(), name: $("#b-name").value.trim() };
    lsSet("aud_order_buyer", JSON.stringify(buyer));
    var btn = $("#go-pay"); btn.disabled = true;
    AudrainCheckout.open({ items: items(), promo: $("#b-promo").value.trim() || null, buyer: buyer }).then(function (r) {
      btn.disabled = false;
      if (r.status === "paid" || r.status === "free") {
        lsSet("aud_last_order", JSON.stringify({ order: r.order, buyer: buyer, at: Date.now() }));
        state.cart = {}; state.names = {}; saveCart(); refreshSteppers();
        return showDone(r.order, buyer, r.pass, r.pending);
      }
      if (r.status === "failed" && r.reason === "hold_expired") { err.textContent = "Your hold ended before payment. Check availability and try again."; err.hidden = false; }
      else if (r.status === "failed" && r.message) { err.textContent = r.message; err.hidden = false; }
      else if (r.status === "not_configured") { err.textContent = "Online payments open soon. Nothing was charged."; err.hidden = false; }
    });
  });

  /* ---------- confirmation + pass QR ---------- */
  var qrLoop = null;
  function passOf(p) { if (!p) return null; var x = p.pass || p; return x && (x.id || x.pass_id || x.serial) ? x : null; }
  function showDone(order, buyer, passData, pending) {
    show("done");
    $("#done-sub").textContent = pending ? "Payment received. Your tickets are being issued - this page updates when they're ready." :
      "Confirmation sent to " + (buyer && buyer.email ? buyer.email : "your email") + ".";
    if (buyer && buyer.email) $("#done-email").textContent = buyer.email;
    var rows = "";
    if (order && order.lines) {
      order.lines.forEach(function (l) { rows += "<tr><td>" + esc(l.name) + " &times; " + l.qty + "</td><td>" + money(l.unit_cents * l.qty, order.currency) + "</td></tr>"; });
      if (order.discount_cents) rows += "<tr><td>Discount</td><td>&minus;" + money(order.discount_cents, order.currency) + "</td></tr>";
      if (order.fees_cents) rows += "<tr><td>Fees</td><td>" + money(order.fees_cents, order.currency) + "</td></tr>";
      if (order.tax_cents) rows += "<tr><td>Tax</td><td>" + money(order.tax_cents, order.currency) + "</td></tr>";
      rows += '<tr class="tot"><td>Paid</td><td>' + money(order.total_cents, order.currency) + "</td></tr>";
      rows += '<tr><td colspan="2" style="font-size:13px;color:var(--muted)">Order ' + esc(String(order.order_id).slice(0, 8).toUpperCase()) + "</td></tr>";
    }
    $("#done-lines tbody").innerHTML = rows;
    if (pending && order) AudrainCheckout.waitForTickets(order.order_id).then(function (r) { if (r.found) { $("#done-sub").textContent = "Your tickets are ready."; startPass(r.pass); } });
    startPass(passData);
  }
  function credKey(passId) { return "aud_cred_" + passId; }
  function getBundle(pass) {
    return AudrainPass.ensureDeviceKey().then(function (key) {
      var cached = null; try { cached = JSON.parse(lsGet(credKey(pass.id || pass.pass_id)) || "null"); } catch (e) {}
      var now = Date.now() / 1000;
      if (cached && cached.claims && cached.claims.dk === key.compressed && (!cached.claims.vt || cached.claims.vt > now)) return cached;
      return AudrainCheckout.callFunction("credential", { pass_id: pass.id || pass.pass_id, jwk: key.jwk }).then(function (b) {
        if (!b.claims && b.claimsB64) b.claims = JSON.parse(new TextDecoder().decode(AudrainPass.b64u.decode(b.claimsB64)));
        lsSet(credKey(pass.id || pass.pass_id), JSON.stringify(b));
        return b;
      });
    });
  }
  function startPass(passData) {
    var pass = passOf(passData), note = $("#qr-note");
    clearInterval(qrLoop);
    if (!pass) { note.textContent = "Your entry QR will appear here once your tickets are issued."; note.hidden = false; return; }
    $("#pass-serial").textContent = pass.serial || "-";
    getBundle(pass).then(function (bundle) {
      note.hidden = true;
      $("#qr-wrap").hidden = false;
      $("#qr-name").textContent = bundle.claims && bundle.claims.n ? bundle.claims.n : (pass.holder_name || "");
      var lastStep = -1;
      var draw = function () {
        var step = AudrainPass.currentStep();
        $("#qr-left").textContent = Math.ceil(AudrainPass.secondsLeft());
        if (step === lastStep) return;
        lastStep = step;
        AudrainPass.qrString(bundle).then(function (s) { return AudrainPass.renderQR($("#qr"), s, { size: 280, label: "Entry QR code for pass " + (pass.serial || "") }); })
          .catch(function (e) { console.warn("[order] qr", e); });
      };
      draw(); qrLoop = setInterval(draw, 1000);
    }).catch(function (e) {
      note.textContent = (e && (e.status === 503 || e.code === "not_configured")) ?
        "Entry QR codes switch on closer to the event. Your tickets are saved to your order - link it in the Audrain app to carry them on your phone." :
        "We couldn't load your entry QR right now (" + (e && e.message ? e.message : "error") + "). Refresh to try again; your tickets are safe.";
      note.hidden = false;
    });
  }

  /* ---------- lookup by email (magic link; needs SMTP on the project) ---------- */
  $("#lookup-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var email = $("#l-email").value.trim().toLowerCase(), msg = $("#l-msg");
    if (!validEmail(email)) { $("#l-email").setAttribute("aria-invalid", "true"); msg.textContent = "Enter a valid email address."; msg.hidden = false; $("#l-email").focus(); return; }
    msg.textContent = "Sending..."; msg.hidden = false;
    client.auth.signInWithOtp({ email: email, options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname + "?lookup=1" } }).then(function (r) {
      if (r.error) throw r.error;
      msg.textContent = "Check " + email + " for a sign-in link. Open it on this device to see your tickets.";
    }).catch(function (err) {
      var m = (err && err.message) || "";
      if (/signups not allowed|not found|user/i.test(m)) msg.textContent = "We couldn't find an order for that email. Check the spelling, or contact us.";
      else if (/smtp|sending|email|rate|limit/i.test(m) || (err && err.status >= 500)) msg.textContent = "Email lookup isn't available yet. Your confirmation stays on the device you ordered from - or contact us and we'll help.";
      else msg.textContent = /fetch|network/i.test(m) ? "You're offline. Try again in a moment." : "Something went wrong: " + m;
    });
  });
  function showLookupResult() {
    show("lookup");
    var box = $("#lookup-result");
    box.innerHTML = '<p class="notice">Loading your tickets...</p>';
    client.schema("tix").rpc("my_pass", { p_app: CFG.app }).then(function (r) {
      if (r.error) throw r.error;
      var p = r.data, pass = passOf(p), tickets = (p && (p.tickets || (p.pass && p.pass.tickets))) || [];
      if (!pass || !tickets.length) { box.innerHTML = '<p class="notice">No 2027 tickets on this account yet.</p>'; return; }
      box.innerHTML = "";
      showDone(null, null, p, false);
      $("#done-lines tbody").innerHTML = tickets.map(function (t) {
        return "<tr><td>" + esc(t.type_name || t.name || t.ticket_type || "Ticket") + "</td><td>" + esc(t.holder_name || "") + "</td></tr>";
      }).join("");
      $("#done-sub").textContent = "Signed in. These are the tickets on your account.";
    }).catch(function (e) { box.innerHTML = '<p class="notice err">Could not load tickets: ' + esc(e.message || "error") + "</p>"; });
  }

  $("#optout").addEventListener("click", function (e) {
    e.preventDefault();
    if (window.AudrainTrack) AudrainTrack.setConsent(false);
    say("Done. We won't use cookies or share your activity for advertising on this device.");
    e.target.textContent = "Opted out of sale/sharing";
  });

  /* ---------- boot ---------- */
  function boot() {
    try { var s = JSON.parse(ssGet("aud_order_cart") || "null"); if (s) { state.cart = s.cart || {}; state.names = s.names || {}; } } catch (e) {}
    if (!window.supabase || !window.supabase.createClient) { $("#catalog").innerHTML = '<p class="notice err">The box office could not load. Refresh to try again.</p>'; return; }
    client = window.supabase.createClient(CFG.url, CFG.anon, {
      auth: { storageKey: CFG.storageKey || "sb-concours-order", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "implicit" }
    });
    window.ORDER_CLIENT = client;
    if (window.AudrainTrack) { AudrainTrack.configure({ supabase: client, app: CFG.app }); AudrainTrack.pageView({ page: "order" }); }
    AudrainCheckout.configure({ supabase: client, app: CFG.app, functionsUrl: CFG.functionsUrl || CFG.url + "/functions/v1", anonKey: CFG.anon, termsUrl: "terms.html", refundUrl: "refund.html" });

    var q = new URLSearchParams(location.search);
    if (location.hash === "#lookup") show("lookup", false);
    if (q.get("order_id")) {
      var last = null; try { last = JSON.parse(lsGet("aud_last_order") || "null"); } catch (e) {}
      var buyer = last && last.buyer;
      if (q.get("redirect_status") === "failed") { show("details"); $("#det-err").textContent = "That payment didn't go through. You have not been charged."; $("#det-err").hidden = false; }
      else {
        showDone(last && last.order && last.order.order_id === q.get("order_id") ? last.order : null, buyer, null, true);
        AudrainCheckout.resume(q.get("order_id")).then(function (r) { if (!r.pending) { $("#done-sub").textContent = "Your tickets are ready."; startPass(r.pass); } });
      }
    }
    if (q.get("lookup") || /access_token=/.test(location.hash)) {
      client.auth.getSession().then(function (r) { if (r.data && r.data.session && !r.data.session.user.is_anonymous) showLookupResult(); });
    }
    client.schema("tix").rpc("catalog", { p_app: CFG.app }).then(function (r) {
      if (r.error) throw r.error;
      var n = normalize(r.data); state.events = n.events; state.types = n.types; state.loaded = true;
      Object.keys(state.cart).forEach(function (id) { if (!state.types[id]) delete state.cart[id]; });
      renderCatalog();
      if (window.AudrainTrack) AudrainTrack.event("view_content", { props: { list: "catalog", events: state.events.length } });
    }).catch(function (e) {
      $("#catalog").setAttribute("aria-busy", "false");
      $("#catalog").innerHTML = '<p class="notice err">' + (/fetch|network/i.test(e.message || "") ? "You're offline. Tickets will load when you reconnect." : "Tickets could not load right now. Please try again shortly.") + "</p>";
    });
  }
  window.addEventListener("hashchange", function () { if (location.hash === "#lookup") show("lookup"); });
  boot();

  window.AudrainOrder = { state: state, normalize: normalize, saleState: saleState, maxFor: maxFor, items: items };   // test hooks
})();
