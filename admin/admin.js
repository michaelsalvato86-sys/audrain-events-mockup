/* Concours admin portal (2026-10-16). Back-office for the in-house ticketing build: sales, catalogue, comps,
   orders and refunds, promo codes, parking and trolleys, finance exports and the audit log.
   Access: staff.has_role('concours','admin'). The database enforces it on every call; this page only hides
   screens. Every write is a security-definer RPC (see audrain-apps/docs/2027-BUILD-CONTRACT.md) or the
   `refund` edge function. Money and destructive actions always ask for a reason and a confirm. */
(function () {
  "use strict";
  var APP = "concours";
  var TZ = "America/New_York";
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var main = $("#main");

  var store = {
    get: function (k, f) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : f; } catch (e) { return f; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private window */ } }
  };
  var state = { view: store.get("adm.view", "dashboard"), order: null, pass: null, preview: null, previewRaw: null, timers: [] };
  var cat = null;          // {events, types} - refreshed after every catalogue write
  var VIEWS = {};

  // ===================================================================================== formatting
  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function money(c) { return (c == null || isNaN(c)) ? "-" : (Number(c) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" }); }
  function toCents(s) { if (s === "" || s == null) return NaN; var n = Number(String(s).replace(/[$,\s]/g, "")); return isFinite(n) ? Math.round(n * 100) : NaN; }
  function dollars(c) { return c == null ? "" : (Number(c) / 100).toFixed(2); }
  function n0(v) { return Number(v || 0).toLocaleString("en-US"); }
  function pct(v) { return v == null || isNaN(v) ? "-" : (Number(v) * 100).toFixed(1) + "%"; }
  function ratio(a, b) { return b ? a / b : null; }
  function fmtDT(iso) { return iso ? new Date(iso).toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "-"; }
  function fmtD(iso) { return iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric", year: "numeric" }) : "-"; }
  // datetime-local inputs work in the browser's own time zone (the team is in Newport, so Eastern).
  function toLocalInput(iso) { if (!iso) return ""; var d = new Date(iso); if (isNaN(d)) return ""; d = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); }
  function fromLocalInput(v) { return v ? new Date(v).toISOString() : null; }
  function dayStart(v) { return v ? new Date(v + "T00:00").toISOString() : null; }
  function dayAfter(v) { if (!v) return null; var d = new Date(v + "T00:00"); d.setDate(d.getDate() + 1); return d.toISOString(); }
  function todayStr() { var d = new Date(); d = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return d.toISOString().slice(0, 10); }
  function pill(text, kind) { return '<span class="pill ' + (kind || "") + '">' + esc(text) + "</span>"; }
  function statusPill(s) {
    var k = { paid: "ok", comp: "ok", claimed: "ok", issued: "", valid: "ok", open: "ok", active: "ok", filling: "warn", pending: "warn",
      partially_refunded: "warn", full: "bad", closed: "bad", refunded: "bad", void: "bad", cancelled: "bad", failed: "bad",
      stock: "", submitted: "warn", accepted: "ok", waitlist: "warn", declined: "bad" }[s];
    return pill(String(s || "-").replace(/_/g, " "), k);
  }
  function meter(used, total) {
    if (!total) return '<span class="muted">No limit</span>';
    var p = Math.min(100, Math.round(100 * used / total));
    return '<div class="barrow"><div class="meter' + (used > total ? " over" : "") + '" role="img" aria-label="' + n0(used) + " of " + n0(total) + ' used"><i style="width:' + p + '%"></i></div><span class="mono">' + n0(used) + " / " + n0(total) + "</span></div>";
  }
  function emptyRow(cols, text) { return '<tr><td colspan="' + cols + '" class="empty">' + esc(text) + "</td></tr>"; }
  function errBlock(e) { return '<div class="notice warn" role="alert">' + esc(e && e.message || e) + "</div>"; }

  function toast(msg) {
    var t = $("#toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.hidden = true; }, 5000);
  }

  // ===================================================================================== back end
  function rpc(schema, fn, args) { return SB.rpc(schema, fn, args || {}); }
  function sel(schema, table, build) { return SB.select(schema, table, build); }
  // Edge function call (refund). 503 not_configured is a normal state before Stripe opens.
  function callFunction(name, body) {
    return SB.ready.then(function () {
      if (!SB.ok) throw new Error("No connection to the server right now");
      return SB.client.functions.invoke(name, { body: body });
    }).then(function (r) {
      if (!r.error) return r.data;
      var ctx = r.error.context;
      var read = ctx && typeof ctx.json === "function" ? ctx.json().catch(function () { return null; }) : Promise.resolve(null);
      return read.then(function (j) {
        if (j && j.error === "not_configured") throw new Error("Refunds are not connected to Stripe yet. Nothing was refunded.");
        throw new Error((j && (j.message || j.error)) || r.error.message || "The request failed");
      });
    });
  }
  function loadCatalog(force) {
    if (cat && !force) return Promise.resolve(cat);
    return sel("tix", "events", function (q) { return q.eq("app", APP).order("starts_at", { ascending: true, nullsFirst: false }); }).then(function (events) {
      events = events || [];
      var ids = events.map(function (e) { return e.id; });
      return (ids.length ? sel("tix", "ticket_types", function (q) { return q.in("event_id", ids).order("sort"); }) : Promise.resolve([]))
        .then(function (types) { cat = { events: events, types: types || [] }; return cat; });
    });
  }
  function typeById(id) { return cat && cat.types.find(function (t) { return t.id === id; }); }
  function eventById(id) { return cat && cat.events.find(function (e) { return e.id === id; }); }
  function typeLabel(id) { var t = typeById(id); if (!t) return "-"; var e = eventById(t.event_id); return (e ? e.title + " - " : "") + t.name; }
  function typeOptions(selected, blankLabel) {
    var out = blankLabel ? '<option value="">' + esc(blankLabel) + "</option>" : "";
    (cat ? cat.events : []).forEach(function (e) {
      var ts = cat.types.filter(function (t) { return t.event_id === e.id; });
      if (!ts.length) return;
      out += '<optgroup label="' + esc(e.title) + '">' + ts.map(function (t) {
        return '<option value="' + esc(t.id) + '"' + (t.id === selected ? " selected" : "") + ">" + esc(t.name) + (t.price_cents != null ? " (" + money(t.price_cents) + ")" : "") + "</option>";
      }).join("") + "</optgroup>";
    });
    return out;
  }

  // ===================================================================================== dialog
  var dlg = $("#dlg"), dlgSpec = null, dlgResolve = null;
  function openDialog(spec) {
    return new Promise(function (res) {
      if (dlg.open) closeDialog(null);
      dlgSpec = spec; dlgResolve = res;
      dlg.classList.toggle("wide", !!spec.wide);
      $("#dlgTitle").textContent = spec.title;
      $("#dlgBody").innerHTML = spec.body || "";
      $("#dlgErr").textContent = "";
      // Primary first in the DOM so Enter submits it; CSS row-reverse puts it on the right.
      var btns = spec.buttons || [{ label: "Close", value: "cancel", cls: "ghost" }];
      $("#dlgBtns").innerHTML = btns.map(function (b) {
        return '<button type="submit" class="btn ' + (b.cls || "primary") + '" value="' + esc(b.value) + '">' + esc(b.label) + "</button>";
      }).join("");
      dlg.showModal();
      if (spec.onOpen) spec.onOpen($("#dlgBody"));
      var first = $("#dlgBody").querySelector("input:not([type=hidden]):not([disabled]),select,textarea");
      (spec.focusButton || !first ? $("#dlgBtns button") : first).focus();
    });
  }
  function closeDialog(val) { if (dlg.open) dlg.close(); var r = dlgResolve; dlgResolve = null; dlgSpec = null; if (r) r(val); }
  $("#dlgForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var v = e.submitter ? e.submitter.value : (dlgSpec && dlgSpec.buttons ? dlgSpec.buttons[0].value : "ok");
    if (v === "cancel") return closeDialog(null);
    var body = $("#dlgBody");
    if (dlgSpec && dlgSpec.validate) {
      var err = dlgSpec.validate(body, v);
      if (err) { $("#dlgErr").textContent = err; return; }
    }
    closeDialog(dlgSpec && dlgSpec.collect ? dlgSpec.collect(body, v) : v);
  });
  dlg.addEventListener("cancel", function (e) { e.preventDefault(); closeDialog(null); });

  /* Confirm for money / destructive actions. Resolves the typed reason (string), or null when cancelled.
     opts.reason === false makes it a plain yes/no and resolves true. */
  function confirmAction(opts) {
    var needReason = opts.reason !== false;
    return openDialog({
      title: opts.title,
      body: (opts.danger ? '<div class="notice warn">' : '<div class="notice">') + opts.message + "</div>" +
        (needReason ? '<div class="field"><label for="cfReason">' + esc(opts.reasonLabel || "Reason (required, saved in the audit log)") + '</label><textarea id="cfReason" required minlength="3" maxlength="500">' + esc(opts.presetReason || "") + "</textarea></div>" : ""),
      buttons: [{ label: opts.confirmLabel || "Confirm", value: "ok", cls: opts.danger ? "danger" : "primary" }, { label: "Cancel", value: "cancel", cls: "ghost" }],
      focusButton: !needReason,
      validate: function (b) { if (needReason && $("#cfReason", b).value.trim().length < 3) return "Enter a reason (at least 3 characters)."; },
      collect: function (b) { return needReason ? $("#cfReason", b).value.trim() : true; }
    });
  }

  // Form field builder for editor dialogs.
  function fld(id, label, type, value, o) {
    o = o || {};
    var cls = "field" + (o.wide ? " wide" : ""), hint = o.hint ? ' <span class="hint">' + esc(o.hint) + "</span>" : "";
    var attrs = (o.required ? " required" : "") + (o.disabled ? " disabled" : "") + (o.attrs || "") + (o.hint ? ' aria-describedby="' + id + '_h"' : "");
    if (o.hint) hint = ' <span class="hint" id="' + id + '_h">' + esc(o.hint) + "</span>";
    if (type === "check") return '<div class="' + cls + '"><label class="check"><input type="checkbox" id="' + id + '"' + (value ? " checked" : "") + attrs + "> " + esc(label) + "</label>" + hint + "</div>";
    var ctl;
    if (type === "select") ctl = '<select id="' + id + '"' + attrs + ">" + (o.html || (o.options || []).map(function (op) {
      return '<option value="' + esc(op[0]) + '"' + (String(op[0]) === String(value == null ? "" : value) ? " selected" : "") + ">" + esc(op[1]) + "</option>"; }).join("")) + "</select>";
    else if (type === "textarea") ctl = '<textarea id="' + id + '"' + attrs + ">" + esc(value) + "</textarea>";
    else ctl = '<input type="' + type + '" id="' + id + '" value="' + esc(value == null ? "" : value) + '"' + attrs + ">";
    return '<div class="' + cls + '"><label for="' + id + '">' + esc(label) + "</label>" + ctl + hint + "</div>";
  }
  function v(root, id) { var el = $("#" + id, root); return el ? (el.type === "checkbox" ? el.checked : el.value.trim()) : null; }
  function intOrNull(s) { return s === "" || s == null ? null : Number(s); }
  function isInt(s, min, max) { if (s === "" || s == null) return true; var n = Number(s); return Number.isInteger(n) && n >= min && (max == null || n <= max); }
  var EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]{2,}$/;

  // ===================================================================================== shell + auth
  function show(id) { ["gate", "denied", "boot", "shell"].forEach(function (x) { $("#" + x).hidden = x !== id; }); }
  function go(name) {
    if (!VIEWS[name]) name = "dashboard";
    state.timers.forEach(clearInterval); state.timers = [];
    state.view = name; store.set("adm.view", name);
    $$(".side button").forEach(function (b) { if (b.dataset.view === name) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
    main.innerHTML = '<div class="view"><p class="muted" role="status">Loading...</p></div>';
    main.focus({ preventScroll: true });
    Promise.resolve().then(VIEWS[name]).catch(function (e) { console.warn(e); main.innerHTML = '<div class="view">' + errBlock(e) + "</div>"; });
  }
  $$(".side button").forEach(function (b) { b.addEventListener("click", function () { go(b.dataset.view); }); });

  var lastUid;
  function onUser(user) {
    var uid = user && !user.is_anonymous ? user.id : null;
    if (uid === lastUid) return;
    lastUid = uid;
    if (!uid) { show("gate"); return; }
    show("boot"); $("#bootMsg").textContent = "Checking your access...";
    rpc("staff", "has_role", { p_app: APP, p_min: "admin" }).then(function (ok) {
      if (lastUid !== uid) return;
      if (ok !== true) { $("#deniedWho").textContent = user.email || "This account"; show("denied"); return; }
      $("#whoTxt").textContent = user.email || "";
      show("shell"); go(state.view);
    }).catch(function (e) { $("#bootMsg").textContent = "Could not check your access: " + e.message; });
  }
  var urlNote = "";
  // sb.js turns off detectSessionInUrl, so the magic-link return (#access_token=... or ?code=...) is read here.
  function handleUrlSession() {
    if (!SB.ok) return null;
    var h = new URLSearchParams(location.hash.slice(1)), q = new URLSearchParams(location.search), p = null;
    if (h.get("access_token") && h.get("refresh_token")) p = SB.client.auth.setSession({ access_token: h.get("access_token"), refresh_token: h.get("refresh_token") });
    else if (q.get("code")) p = SB.client.auth.exchangeCodeForSession(q.get("code"));
    else if (h.get("error_description")) urlNote = "That sign-in link did not work: " + h.get("error_description");
    if (h.toString() || q.get("code")) history.replaceState(null, "", location.pathname);
    return p && p.then(function (r) { if (r && r.error) urlNote = "That sign-in link did not work: " + r.error.message; });
  }
  SB.ready.then(handleUrlSession).then(function () {
    if (!SB.ok) { $("#bootMsg").textContent = "Cannot reach the server. Check your connection and reload the page."; return; }
    if (urlNote) $("#siErr").textContent = urlNote;
    SB.onAuth(onUser);
  });

  $("#signinForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var email = $("#siEmail").value.trim(), pw = $("#siPass").value, err = $("#siErr");
    err.textContent = ""; $("#siNote").textContent = "";
    if (!EMAIL_RE.test(email)) { err.textContent = "Enter your work email."; return; }
    if (!pw) { err.textContent = "Enter your password, or use the email link."; return; }
    $("#siSubmit").disabled = true;
    SB.signIn(email, pw).catch(function (x) { err.textContent = x.message; }).then(function () { $("#siSubmit").disabled = false; });
  });
  $("#siMagic").addEventListener("click", function () {
    var email = $("#siEmail").value.trim(), err = $("#siErr");
    err.textContent = ""; $("#siNote").textContent = "";
    if (!EMAIL_RE.test(email)) { err.textContent = "Enter your work email first."; return; }
    SB.ready.then(function () {
      return SB.client.auth.signInWithOtp({ email: email.toLowerCase(), options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname } });
    }).then(function (r) {
      if (r.error) throw r.error;
      $("#siNote").textContent = "Check your email for a sign-in link. It opens this page signed in.";
    }).catch(function (x) { err.textContent = x.message || "Could not send the link"; });
  });
  function signOut() { SB.signOut().catch(function () {}).then(function () { cat = null; onUser(null); }); }
  $("#signOut").addEventListener("click", signOut);
  $("#deniedOut").addEventListener("click", signOut);

  // Wraps a button handler: disables the button while the call runs and shows errors as a toast.
  function busy(btn, fn) {
    return function (ev) {
      if (ev) ev.preventDefault();
      if (btn) btn.disabled = true;
      return Promise.resolve().then(fn).catch(function (e) { console.warn(e); toast(e.message || String(e)); })
        .then(function () { if (btn) btn.disabled = false; });
    };
  }
  function on(id, evt, fn) { var el = typeof id === "string" ? $("#" + id) : id; if (el) el.addEventListener(evt, busy(el.tagName === "BUTTON" ? el : null, fn)); }

  // ===================================================================================== 1. Sales and gates (live)
  // Was the landing view until 2026-10-22; the season Dashboard (analytics.admin_dashboard) is section 9 below.
  VIEWS.live = function () {
    var from = store.get("adm.fFrom", ""), to = store.get("adm.fTo", "");
    main.innerHTML = '<div class="view">' +
      '<div class="head"><h1>Sales and gates</h1><button type="button" class="btn ghost" id="dRefresh">Refresh</button></div>' +
      '<section aria-labelledby="hSales"><h2 id="hSales" class="sr">Sales</h2><div id="dTiles" class="grid tiles"><p class="muted">Loading sales...</p></div></section>' +
      '<section class="panel" aria-labelledby="hTypes"><h2 id="hTypes">Sales by event and ticket type</h2><div id="dTypes"></div></section>' +
      '<section class="panel" aria-labelledby="hGates"><h2 id="hGates">Live gate counts</h2><div id="dGates" class="grid tiles"></div><p class="hint">Today, Eastern time. Refreshes every 30 seconds.</p></section>' +
      '<section class="panel" aria-labelledby="hFunnel"><div class="head"><h2 id="hFunnel">Funnel by campaign</h2>' +
      '<form id="fForm" class="btns">' + '<div class="field"><label for="fFrom">From</label><input type="date" id="fFrom" value="' + esc(from) + '"></div>' +
      '<div class="field"><label for="fTo">To</label><input type="date" id="fTo" value="' + esc(to) + '"></div>' +
      '<button class="btn ghost" type="submit" style="align-self:flex-end">Apply</button></form></div>' +
      '<p class="hint">Unique visitors who viewed, added to cart and started checkout; purchases are orders; attended is passes scanned at a gate. Campaign is utm_campaign from the first visit.</p>' +
      '<div id="dFunnel"></div></section></div>';
    function loadSales() {
      return rpc("tix", "admin_sales_summary", { p_app: APP }).then(renderSales).catch(function (e) { $("#dTiles").innerHTML = errBlock(e); });
    }
    function loadGates() {
      return rpc("tix", "gate_counts", { p_app: APP }).then(function (g) {
        g = g || {};
        $("#dGates").innerHTML = tile("Admitted today", n0(g.today_valid)) + tile("Turned away today", n0(g.today_rejected)) + tile("Tickets out", n0(g.tickets_out), "Issued or on a phone");
      }).catch(function (e) { $("#dGates").innerHTML = errBlock(e); });
    }
    function loadFunnel() {
      var f = $("#fFrom").value, t = $("#fTo").value;
      store.set("adm.fFrom", f); store.set("adm.fTo", t);
      return rpc("analytics", "admin_funnel", { p_app: APP, p_from: dayStart(f), p_to: dayAfter(t) }).then(renderFunnel).catch(function (e) { $("#dFunnel").innerHTML = errBlock(e); });
    }
    on("dRefresh", "click", function () { return Promise.all([loadSales(), loadGates(), loadFunnel()]); });
    $("#fForm").addEventListener("submit", function (e) { e.preventDefault(); loadFunnel(); });
    state.timers.push(setInterval(loadGates, 30000));
    return Promise.all([loadSales(), loadGates(), loadFunnel()]);
  };
  function tile(k, v, s) { return '<div class="tile"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + "</div>" + (s ? '<div class="s">' + esc(s) + "</div>" : "") + "</div>"; }
  function renderSales(s) {
    s = s || {}; var rows = s.by_type || [];
    var paid = s.paid_tickets != null ? s.paid_tickets : rows.reduce(function (a, r) { return a + (r.paid_qty || 0); }, 0);
    var comp = s.comp_tickets != null ? s.comp_tickets : rows.reduce(function (a, r) { return a + (r.comp_qty || 0); }, 0);
    $("#dTiles").innerHTML = tile("Revenue", money(s.revenue_cents), "Paid orders, before refunds") + tile("Paid tickets", n0(paid)) + tile("Comp tickets", n0(comp)) +
      tile("Add-on attach rate", pct(s.addon_attach_rate), "Paid orders with an add-on") + tile("Orders today", n0(s.orders_today)) + tile("Holds active", n0(s.holds_active), "Carts holding inventory now");
    $("#dTypes").innerHTML = '<div class="tablewrap"><table><thead><tr><th scope="col">Event</th><th scope="col">Ticket type</th><th scope="col">Kind</th><th scope="col" class="num">Paid</th><th scope="col" class="num">Comp</th><th scope="col" class="num">Revenue</th><th scope="col">Capacity used</th></tr></thead><tbody>' +
      (rows.length ? rows.map(function (r) {
        return "<tr><td>" + esc(r.event) + "</td><td>" + esc(r.ticket_type) + "</td><td>" + esc(r.kind || "ticket") + '</td><td class="num">' + n0(r.paid_qty) + '</td><td class="num">' + n0(r.comp_qty) +
          '</td><td class="num">' + money(r.revenue_cents) + "</td><td>" + meter((r.paid_qty || 0) + (r.comp_qty || 0), r.capacity) + "</td></tr>";
      }).join("") : emptyRow(7, "No sales yet.")) + "</tbody></table></div>";
  }
  function renderFunnel(rows) {
    rows = rows || [];
    var keys = ["views", "add_to_cart", "checkout", "purchase", "attended"];
    var tot = { campaign: "All campaigns", revenue_cents: 0 }; keys.forEach(function (k) { tot[k] = 0; });
    rows.forEach(function (r) { keys.forEach(function (k) { tot[k] += Number(r[k] || 0); }); tot.revenue_cents += Number(r.revenue_cents || 0); });
    function line(r, strong) {
      var c = strong ? "th" : "td", sc = strong ? ' scope="row"' : "";
      return "<tr><" + c + sc + ">" + esc(r.campaign) + "</" + c + ">" + keys.map(function (k) { return '<td class="num">' + n0(r[k]) + "</td>"; }).join("") +
        '<td class="num">' + pct(ratio(Number(r.purchase || 0), Number(r.views || 0))) + '</td><td class="num">' + money(r.revenue_cents) + "</td></tr>";
    }
    $("#dFunnel").innerHTML = '<div class="tablewrap"><table><thead><tr><th scope="col">Campaign</th><th scope="col" class="num">Views</th><th scope="col" class="num">Add to cart</th><th scope="col" class="num">Checkout</th><th scope="col" class="num">Purchase</th><th scope="col" class="num">Attended</th><th scope="col" class="num">View to purchase</th><th scope="col" class="num">Revenue</th></tr></thead><tbody>' +
      (rows.length ? rows.map(function (r) { return line(r); }).join("") + line(tot, true) : emptyRow(8, "No tracked visits in this date range.")) + "</tbody></table></div>";
  }

  // ===================================================================================== 2. Events and ticket types
  var EVENT_KINDS = [["signature", "Signature event"], ["community", "Community event"], ["session", "Session"], ["pass", "Pass"], ["dinner", "Dinner"]];
  var TYPE_KINDS = [["ticket", "Ticket"], ["addon", "Add-on"], ["parking", "Parking"], ["admission", "Admission"], ["membership", "Membership"], ["merch", "Merchandise"]];
  VIEWS.events = function () {
    return loadCatalog(true).then(function () {
      main.innerHTML = '<div class="view"><div class="head"><h1>Events and tickets</h1><button type="button" class="btn" id="evNew">New event</button></div>' +
        '<p class="hint">Unpublished events and ticket types that are not on sale are invisible to the public. Times are Eastern.</p>' +
        (cat.events.length ? cat.events.map(eventPanel).join("") : '<div class="panel empty">No events yet. Use New event to add one.</div>') + "</div>";
      on("evNew", "click", function () { return editEvent(null); });
      $$("[data-ev-edit]").forEach(function (b) { on(b, "click", function () { return editEvent(eventById(b.dataset.evEdit)); }); });
      $$("[data-tt-new]").forEach(function (b) { on(b, "click", function () { return editType(null, b.dataset.ttNew); }); });
      $$("[data-tt-edit]").forEach(function (b) { on(b, "click", function () { var t = typeById(b.dataset.ttEdit); return editType(t, t.event_id); }); });
    });
  };
  function eventPanel(e) {
    var ts = cat.types.filter(function (t) { return t.event_id === e.id; });
    return '<section class="panel" aria-label="' + esc(e.title) + '"><div class="head"><div><h2>' + esc(e.title) + "</h2>" +
      '<div class="muted">' + esc(e.slug) + " - " + esc(e.kind) + (e.venue ? " - " + esc(e.venue) : "") + " - " + fmtDT(e.starts_at) + (e.ends_at ? " to " + fmtDT(e.ends_at) : "") + "</div></div>" +
      '<div class="btns">' + (e.published ? pill("Published", "ok") : pill("Not published", "warn")) +
      '<button type="button" class="btn ghost sm" data-ev-edit="' + esc(e.id) + '">Edit event</button><button type="button" class="btn sm" data-tt-new="' + esc(e.id) + '">Add ticket type</button></div></div>' +
      '<div class="tablewrap" style="margin-top:10px"><table><thead><tr><th scope="col">Ticket type</th><th scope="col">Kind</th><th scope="col" class="num">Price</th><th scope="col" class="num">Tax</th><th scope="col" class="num">Capacity</th><th scope="col" class="num">Per order</th><th scope="col">Zones</th><th scope="col">Sales window</th><th scope="col">GL code</th><th scope="col">Status</th><th scope="col"><span class="sr">Actions</span></th></tr></thead><tbody>' +
      (ts.length ? ts.map(function (t) {
        return "<tr><td>" + esc(t.name) + (t.requires_parent ? ' <span class="hint">(needs a ticket)</span>' : "") + "</td><td>" + esc(t.kind || "ticket") + '</td><td class="num">' + money(t.price_cents) +
          '</td><td class="num">' + ((t.tax_rate_bp || 0) / 100).toFixed(2) + '%</td><td class="num">' + (t.capacity == null ? "No limit" : n0(t.capacity)) + '</td><td class="num">' + n0(t.per_order_max) +
          "</td><td>" + esc((t.zones || ["general"]).join(", ")) + "</td><td>" + (t.sales_start || t.sales_end ? fmtD(t.sales_start) + " to " + fmtD(t.sales_end) : "Any time") +
          '</td><td class="mono">' + esc(t.gl_code || "-") + "</td><td>" + (t.sales_open ? pill("On sale", "ok") : pill("Off sale")) +
          '</td><td><button type="button" class="btn ghost sm" data-tt-edit="' + esc(t.id) + '">Edit</button></td></tr>';
      }).join("") : emptyRow(11, "No ticket types yet.")) + "</tbody></table></div></section>";
  }
  function editEvent(ev) {
    var orig = ev || { kind: "signature", sold_in_app: true, published: false };
    var draft = Object.assign({}, orig);
    function form(d) {
      return {
        title: ev ? "Edit event" : "New event", wide: true,
        body: '<div class="form">' + fld("f_title", "Title", "text", d.title, { required: true, wide: true }) +
          fld("f_slug", "Short name for links", "text", d.slug, { required: true, hint: "Lower case letters, numbers and dashes, e.g. concours-2027" }) +
          fld("f_kind", "Kind", "select", d.kind, { options: EVENT_KINDS }) + fld("f_venue", "Venue", "text", d.venue) +
          fld("f_start", "Starts", "datetime-local", toLocalInput(d.starts_at)) + fld("f_end", "Ends", "datetime-local", toLocalInput(d.ends_at)) +
          fld("f_sold", "Sold in this app", "check", d.sold_in_app) + fld("f_ext", "Outside seller link", "url", d.external_url, { hint: "Only when not sold in the app" }) +
          fld("f_pub", "Published (visible to the public)", "check", d.published, { wide: true }) + "</div>",
        buttons: [{ label: "Save event", value: "save" }, { label: "Cancel", value: "cancel", cls: "ghost" }],
        validate: function (b) {
          if (!v(b, "f_title")) return "Enter a title.";
          if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(v(b, "f_slug"))) return "The short name can only have lower case letters, numbers and single dashes.";
          var s = v(b, "f_start"), en = v(b, "f_end");
          if (s && en && new Date(en) <= new Date(s)) return "The end must be after the start.";
          var x = v(b, "f_ext"); if (x && !/^https:\/\//i.test(x)) return "The outside seller link must start with https://";
        },
        collect: function (b) {
          return { id: ev ? ev.id : undefined, title: v(b, "f_title"), slug: v(b, "f_slug"), kind: v(b, "f_kind"), venue: v(b, "f_venue") || null,
            starts_at: fromLocalInput(v(b, "f_start")), ends_at: fromLocalInput(v(b, "f_end")), sold_in_app: v(b, "f_sold"),
            external_url: v(b, "f_ext") || null, published: v(b, "f_pub") };
        }
      };
    }
    function loop() {
      return openDialog(form(draft)).then(function (d) {
        if (!d) return;
        draft = d;
        var step = Promise.resolve("");
        if (!!d.published !== !!orig.published) {
          step = confirmAction({ title: d.published ? "Publish this event?" : "Unpublish this event?", confirmLabel: d.published ? "Publish" : "Unpublish",
            danger: !d.published,
            message: d.published ? "<b>" + esc(d.title) + "</b> will be visible to the public in the app and on the ordering site. Ticket types still need to be on sale before anyone can buy."
              : "<b>" + esc(d.title) + "</b> will disappear from the app and the ordering site. Tickets already sold still scan." });
        }
        return step.then(function (reason) {
          if (reason === null) return loop();        // back to the editor with the edits kept
          var payload = Object.assign({}, d); if (payload.id === undefined) delete payload.id; if (reason) payload._reason = reason;
          return rpc("tix", "admin_upsert_event", { p_app: APP, p_event: payload }).then(function () { toast("Event saved"); return VIEWS.events(); });
        });
      });
    }
    return loop();
  }
  function editType(t, eventId) {
    var orig = t || { event_id: eventId, kind: "ticket", price_cents: 0, per_order_max: 10, zones: ["general"], scan_rule: "once", tax_rate_bp: 0, sales_open: false, requires_parent: false, sort: 0 };
    var draft = Object.assign({}, orig);
    function form(d) {
      return {
        title: (t ? "Edit ticket type - " : "New ticket type - ") + ((eventById(eventId) || {}).title || ""), wide: true,
        body: '<div class="form">' + fld("f_name", "Name", "text", d.name, { required: true, wide: true }) +
          fld("f_kind", "Kind", "select", d.kind || "ticket", { options: TYPE_KINDS }) +
          fld("f_price", "Price (dollars)", "text", dollars(d.price_cents), { attrs: ' inputmode="decimal"', hint: "0 for free" }) +
          fld("f_fee", "Fee per ticket (dollars)", "text", dollars(d.fee_cents || 0), { attrs: ' inputmode="decimal"', hint: "Mandatory per-ticket fee, shown in the all-in price; 0 for none" }) +
          fld("f_tax", "Tax rate (percent)", "text", ((d.tax_rate_bp || 0) / 100).toString(), { attrs: ' inputmode="decimal"', hint: "e.g. 7 for 7%" }) +
          fld("f_cap", "Capacity", "number", d.capacity, { attrs: ' min="0" step="1"', hint: "Blank for no limit" }) +
          fld("f_max", "Most per order", "number", d.per_order_max, { attrs: ' min="1" max="100" step="1"' }) +
          fld("f_zones", "Zones", "text", (d.zones || ["general"]).join(", "), { hint: "Comma separated, e.g. general, vip" }) +
          fld("f_ss", "Sales start", "datetime-local", toLocalInput(d.sales_start)) + fld("f_se", "Sales end", "datetime-local", toLocalInput(d.sales_end)) +
          fld("f_vf", "Valid from", "datetime-local", toLocalInput(d.valid_from), { hint: "Session window; blank for the whole event" }) + fld("f_vt", "Valid to", "datetime-local", toLocalInput(d.valid_to)) +
          fld("f_rule", "Scan rule", "select", d.scan_rule || "once", { options: [["once", "Once"], ["once_per_day", "Once per day"]] }) +
          fld("f_gl", "GL code", "text", d.gl_code, { hint: "For finance exports" }) + fld("f_sort", "Sort order", "number", d.sort, { attrs: ' step="1"' }) +
          fld("f_img", "Image link", "url", d.image_url, { wide: true, hint: "https link to the image" }) +
          fld("f_desc", "Description", "textarea", d.description, { wide: true }) +
          fld("f_parent", "Needs a ticket in the same pass (add-on)", "check", d.requires_parent) +
          fld("f_open", "On sale", "check", d.sales_open) + "</div>",
        buttons: [{ label: "Save ticket type", value: "save" }, { label: "Cancel", value: "cancel", cls: "ghost" }],
        validate: function (b) {
          if (!v(b, "f_name")) return "Enter a name.";
          var c = toCents(v(b, "f_price")); if (isNaN(c) || c < 0) return "Enter a price of 0 or more.";
          var fc = toCents(v(b, "f_fee")); if (isNaN(fc) || fc < 0) return "Enter a fee of 0 or more.";
          var tx = Number(v(b, "f_tax")); if (v(b, "f_tax") === "" || isNaN(tx) || tx < 0 || tx > 30) return "Enter a tax rate between 0 and 30 percent.";
          if (!isInt(v(b, "f_cap"), 0)) return "Capacity must be a whole number, or blank.";
          if (!isInt(v(b, "f_max"), 1, 100) || v(b, "f_max") === "") return "Most per order must be between 1 and 100.";
          var ss = v(b, "f_ss"), se = v(b, "f_se"); if (ss && se && new Date(se) <= new Date(ss)) return "Sales end must be after sales start.";
          var vf = v(b, "f_vf"), vt = v(b, "f_vt"); if (vf && vt && new Date(vt) <= new Date(vf)) return "Valid to must be after valid from.";
          var img = v(b, "f_img"); if (img && !/^https:\/\//i.test(img)) return "The image link must start with https://";
          var z = v(b, "f_zones").split(",").map(function (s) { return s.trim(); }).filter(Boolean); if (!z.length) return "Add at least one zone.";
          if (z.some(function (s) { return !/^[a-z0-9_]+$/i.test(s); })) return "Zones can only have letters, numbers and underscores.";
        },
        collect: function (b) {
          return { id: t ? t.id : undefined, event_id: eventId, name: v(b, "f_name"), kind: v(b, "f_kind"), price_cents: toCents(v(b, "f_price")), fee_cents: toCents(v(b, "f_fee")),
            tax_rate_bp: Math.round(Number(v(b, "f_tax")) * 100), capacity: intOrNull(v(b, "f_cap")), per_order_max: Number(v(b, "f_max")),
            zones: v(b, "f_zones").split(",").map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean),
            sales_start: fromLocalInput(v(b, "f_ss")), sales_end: fromLocalInput(v(b, "f_se")), valid_from: fromLocalInput(v(b, "f_vf")), valid_to: fromLocalInput(v(b, "f_vt")),
            scan_rule: v(b, "f_rule"), gl_code: v(b, "f_gl") || null, sort: Number(v(b, "f_sort") || 0), image_url: v(b, "f_img") || null,
            description: v(b, "f_desc") || null, requires_parent: v(b, "f_parent"), sales_open: v(b, "f_open") };
        }
      };
    }
    function loop() {
      return openDialog(form(draft)).then(function (d) {
        if (!d) return;
        draft = d;
        var changes = [];
        if (t && d.price_cents !== t.price_cents) changes.push("Price changes from " + money(t.price_cents) + " to <b>" + money(d.price_cents) + "</b>. Orders already paid keep their price.");
        if (t && d.fee_cents !== (t.fee_cents || 0)) changes.push("Fee changes from " + money(t.fee_cents || 0) + " to <b>" + money(d.fee_cents) + "</b> per ticket.");
        if (!!d.sales_open !== !!orig.sales_open) changes.push(d.sales_open ? "<b>" + esc(d.name) + "</b> goes on sale (inside its sales window, once the event is published)." : "<b>" + esc(d.name) + "</b> comes off sale. Tickets already sold still scan.");
        var step = changes.length ? confirmAction({ title: "Confirm ticket type change", message: changes.join("<br>"), confirmLabel: "Save change", danger: !d.sales_open && !!orig.sales_open }) : Promise.resolve("");
        return step.then(function (reason) {
          if (reason === null) return loop();
          var payload = Object.assign({}, d); if (payload.id === undefined) delete payload.id; if (reason) payload._reason = reason;
          return rpc("tix", "admin_upsert_ticket_type", { p_app: APP, p_ticket_type: payload }).then(function () { toast("Ticket type saved"); return VIEWS.events(); });
        });
      });
    }
    return loop();
  }

  // ===================================================================================== 3. Comps
  /* CSV: email,name per row. An optional header row is skipped. Quotes are honoured. */
  function parseCSV(text) {
    var rows = [], row = [], cell = "", q = false, i, c;
    text = String(text || "").replace(/^﻿/, "");
    for (i = 0; i < text.length; i++) {
      c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
      else if (c === '"') q = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
      else cell += c;
    }
    if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (x) { return x.trim() !== ""; }); });
  }
  /* Comp list import (2026-10-22). Without a header row each line is email,name. With a header row (a cell named
     "email") columns are matched by name: email, name, qty, ticket_type (name, "Event - Type" or id), sponsor (name or id),
     pool (name or id), note. Blank cells take the form's values. issue_comp2 has no sponsor argument - a comp gets its
     sponsor from its pool - so a sponsor cell picks that sponsor's pool when the pool cell is blank. */
  var CSV_ALIAS = { email: "email", e_mail: "email", name: "name", qty: "qty", quantity: "qty", tickets: "qty", ticket_type: "ticket_type",
    type: "ticket_type", ticket: "ticket_type", sponsor: "sponsor", pool: "pool", comp_pool: "pool", note: "note", notes: "note" };
  function low(s) { return String(s == null ? "" : s).trim().toLowerCase().replace(/\s+/g, " "); }
  function readCompCSV(rows) {
    var head = rows.length && rows[0].some(function (c) { return /^\s*e-?mail\s*$/i.test(c); }) ? rows[0] : null, cols = {}, unused = [];
    if (head) head.forEach(function (h, i) { var k = CSV_ALIAS[low(h).replace(/[\s-]+/g, "_")]; if (k && cols[k] == null) cols[k] = i; else if (low(h)) unused.push(h.trim()); });
    else { cols = { email: 0, name: 1 }; }
    return { header: !!head, unused: unused, rows: (head ? rows.slice(1) : rows).map(function (r, i) {
      var o = { row: i + 1, extra: !head && r.length > 2 && r.slice(2).some(function (x) { return x.trim(); }) };
      CSV_COLS.forEach(function (k) { o[k] = cols[k] == null ? "" : String(r[cols[k]] || "").trim(); });
      return o;
    }) };
  }
  var CSV_COLS = ["email", "name", "qty", "ticket_type", "sponsor", "pool", "note"];
  function matchOne(list, s, label, what) {
    var k = low(s), hit = list.filter(function (x) { return x.id === s || label(x).some(function (l) { return low(l) === k; }); });
    if (hit.length === 1) return { item: hit[0] };
    return { problem: hit.length ? what + ' "' + s + '" matches ' + hit.length + (what === "Ticket type" ? ': use "Event - Type"' : ": use the id") : "Unknown " + what.toLowerCase() + ' "' + s + '"' };
  }
  /* ctx: {typeId, qty, poolId, note, pools, sponsors (null = sponsors not switched on)}. Returns rows with resolved
     typeId / qty / poolId / note, which values came from the file (from.*), and a problem (rows with one are skipped). */
  function resolveCompRows(parsed, ctx) {
    var seen = {};
    return parsed.rows.map(function (r) {
      var o = { row: r.row, email: r.email.toLowerCase(), name: r.name, qty: ctx.qty, typeId: ctx.typeId || null, poolId: ctx.poolId || null, note: r.note || ctx.note || "",
        sponsor: null, from: { qty: !!r.qty, type: !!r.ticket_type, pool: !!r.pool, sponsor: !!r.sponsor, note: !!r.note }, problem: "" };
      function bad(m) { if (!o.problem) o.problem = m; }
      if (!o.email) bad("Email is missing");
      else if (!EMAIL_RE.test(o.email)) bad("Email is not valid");
      if (r.extra) bad("Too many columns: add a header row (email,name,qty,ticket_type,sponsor,pool,note)");
      if (o.name.length > 120) bad("Name is too long");
      if (r.qty) o.qty = Number(r.qty);
      if (!Number.isInteger(o.qty) || o.qty < 1 || o.qty > 10) bad("Qty must be a whole number from 1 to 10");
      if (r.ticket_type) { var mt = matchOne(cat.types, r.ticket_type, function (t) { return [t.name, typeLabel(t.id)]; }, "Ticket type"); if (mt.item) o.typeId = mt.item.id; else { o.typeId = null; bad(mt.problem); } }
      if (r.sponsor) {
        if (!ctx.sponsors) bad("The sponsor column needs the 09 back end (sponsors are not switched on yet)");
        else { var ms = matchOne(ctx.sponsors, r.sponsor, function (s) { return [s.name]; }, "Sponsor"); if (ms.item) o.sponsor = ms.item; else bad(ms.problem); }
      }
      if (r.pool) { var mp = matchOne(ctx.pools, r.pool, function (p) { return [p.name]; }, "Pool"); o.poolId = mp.item ? mp.item.id : null; if (!mp.item) bad(mp.problem); }
      else if (o.sponsor) {
        var sp = ctx.pools.filter(function (p) { return p.sponsor_id === o.sponsor.id && (!p.ticket_type_id || !o.typeId || p.ticket_type_id === o.typeId); });
        if (sp.length === 1) o.poolId = sp[0].id;
        else bad(sp.length ? o.sponsor.name + " has " + sp.length + " pools: add a pool column" : "No comp pool for " + o.sponsor.name + ": add one under Comp pools");
      }
      var pool = ctx.pools.find(function (p) { return p.id === o.poolId; });
      if (pool && o.sponsor && pool.sponsor_id && pool.sponsor_id !== o.sponsor.id) bad("Pool " + pool.name + " belongs to another sponsor");
      if (pool && !o.typeId && pool.ticket_type_id) o.typeId = pool.ticket_type_id;
      if (!o.typeId) bad("No ticket type: add it in the file or choose one above");
      else if (pool && pool.ticket_type_id && pool.ticket_type_id !== o.typeId) bad("Pool " + pool.name + " is for " + typeLabel(pool.ticket_type_id));
      if (o.note.length > 500) bad("Note is too long");
      var key = o.email + "|" + o.typeId;
      if (!o.problem && seen[key]) bad("Listed twice for this ticket type (row " + seen[key] + ")");
      if (!o.problem) seen[key] = o.row;
      if (o.sponsor === null && pool && pool.sponsor_id && ctx.sponsors) o.sponsor = ctx.sponsors.find(function (s) { return s.id === pool.sponsor_id; }) || null;
      return o;
    });
  }
  /* One issue_comp2 call per distinct (ticket type, qty per person, pool). p_note is the group's note when every row
     shares it, else the form note; each recipient also carries its own note (see Contract changes 2026-10-22 ADMIN).
     issue_comp2 takes at most 200 recipients per call (09), so a bigger group is split into calls of 200. */
  function groupCompRows(rows, formNote) {
    var groups = [], by = {};
    rows.filter(function (x) { return !x.problem; }).forEach(function (x) {
      var k = x.typeId + "|" + x.qty + "|" + (x.poolId || "");
      if (!by[k] || by[k].rows.length >= 200) { by[k] = { typeId: x.typeId, qty: x.qty, poolId: x.poolId, rows: [] }; groups.push(by[k]); }
      by[k].rows.push(x);
    });
    groups.forEach(function (g) {
      var notes = g.rows.map(function (x) { return x.note; });
      g.note = notes.every(function (n) { return n === notes[0]; }) ? notes[0] : formNote;
      g.recipients = g.rows.map(function (x) { var r = { email: x.email, name: x.name || null }; if (x.note) r.note = x.note; return r; });
    });
    return groups;
  }
  VIEWS.comps = function () {
    return Promise.all([loadCatalog(), sel("tix", "comp_reasons", function (q) { return q.order("label"); }), sel("tix", "comp_pools", function (q) { return q.eq("app", APP).order("name"); }), loadSponsors()])
      .then(function (r) {
        var reasons = r[1] || [], pools = r[2] || [], sponsors = r[3];
        state.preview = null; state.previewRaw = null;
        main.innerHTML = '<div class="view"><h1>Comps</h1>' +
          '<section class="panel" aria-labelledby="hIssue"><h2 id="hIssue">Issue comps</h2><form id="cForm" class="form" novalidate>' +
          fld("cType", "Ticket type", "select", "", { html: typeOptions("", "Choose a ticket type"), required: true, hint: "For a list: the default for rows without a ticket_type" }) +
          fld("cQty", "Tickets per person", "number", 1, { attrs: ' min="1" max="10" step="1"' }) +
          fld("cReason", "Reason", "select", "", { required: true, options: [["", "Choose a reason"]].concat(reasons.map(function (x) { return [x.code, x.label]; })) }) +
          fld("cPool", "Comp pool", "select", "", { options: [["", "No pool"]].concat(pools.map(function (p) { return [p.id, p.name + " (" + Math.max(0, (p.allotment || 0) - (p.used || 0)) + " left)"]; })), hint: "Counts against the pool's allotment" }) +
          fld("cNote", "Note", "textarea", "", { wide: true, hint: "Who asked for it and why. Saved with each comp." }) +
          '<fieldset class="wide" style="border:0;padding:0;margin:0"><legend class="lbl">Recipients</legend><div class="segmented" role="group" aria-label="Recipients"><button type="button" id="cModeOne" aria-pressed="true">One person</button><button type="button" id="cModeList" aria-pressed="false">Upload a list</button></div></fieldset>' +
          '<div class="wide" id="cOne"><div class="form">' + fld("cEmail", "Email", "email", "") + fld("cName", "Name", "text", "") + "</div></div>" +
          '<div class="wide" id="cList" hidden><div class="form">' + fld("cFile", "CSV file", "file", "", { attrs: ' accept=".csv,text/csv"', hint: "email,name per row, or a header row with any of email, name, qty, ticket_type, sponsor, pool, note. Blank cells use the values above." }) +
          fld("cPaste", "Or paste rows", "textarea", "", { hint: "Same format as the file" }) + '</div><div class="btns" style="margin-top:8px"><button type="button" class="btn ghost" id="cPreviewBtn">Preview list</button><button type="button" class="btn ghost" id="cTemplate">Download template</button></div><div id="cPreview" style="margin-top:10px"></div></div>' +
          '<p class="err wide" id="cErr" role="alert"></p><div class="btns wide"><button type="submit" class="btn" id="cIssue">Issue comps</button></div></form></section>' +
          '<section class="panel" aria-labelledby="hPools"><div class="head"><h2 id="hPools">Comp pools</h2><button type="button" class="btn ghost" id="pNew">New pool</button></div><div id="pTable" style="margin-top:10px"></div></section>' +
          '<section class="panel" aria-labelledby="hCompRep"><h2 id="hCompRep">Comp report</h2><p class="hint">Sponsor package vs straight comps and show rate per sponsor are on the Sponsors page.</p><div id="cReport"><p class="muted">Loading...</p></div></section></div>';
        renderPools(pools, sponsors);
        var mode = "one";
        function setMode(m) { mode = m; $("#cModeOne").setAttribute("aria-pressed", m === "one"); $("#cModeList").setAttribute("aria-pressed", m === "list"); $("#cOne").hidden = m !== "one"; $("#cList").hidden = m !== "list"; }
        $("#cModeOne").addEventListener("click", function () { setMode("one"); });
        $("#cModeList").addEventListener("click", function () { setMode("list"); });
        $("#cPool").addEventListener("change", function () { var p = pools.find(function (x) { return x.id === $("#cPool").value; }); if (p && p.ticket_type_id) $("#cType").value = p.ticket_type_id; });
        function ctx() { return { typeId: $("#cType").value, qty: Number($("#cQty").value), poolId: $("#cPool").value || null, note: $("#cNote").value.trim(), pools: pools, sponsors: sponsors }; }
        // The form values are the defaults for blank cells, so the preview is re-resolved whenever they change.
        function resolve() { if (!state.previewRaw) return; state.preview = resolveCompRows(state.previewRaw, ctx()); renderPreview(pools); }
        function preview(text) { state.previewRaw = readCompCSV(parseCSV(text)); resolve(); }
        ["cType", "cQty", "cPool", "cNote"].forEach(function (id) { $("#" + id).addEventListener("change", resolve); });
        $("#cFile").addEventListener("change", function () {
          var f = $("#cFile").files[0]; if (!f) return;
          if (f.size > 512 * 1024) { $("#cPreview").innerHTML = errBlock("That file is too big. Keep lists under 500 people."); return; }
          f.text().then(preview);
        });
        $("#cPreviewBtn").addEventListener("click", function () { preview($("#cPaste").value); });
        $("#cTemplate").addEventListener("click", function () {
          var t = cat.types[0], s = sponsors && sponsors[0];
          download("concours-comps-template.csv", toCSV([["email", "email"], ["name", "name"], ["qty", "qty"], ["ticket_type", "ticket_type"], ["sponsor", "sponsor"], ["pool", "pool"], ["note", "note"]], [
            { email: "guest@example.com", name: "Example Guest", qty: 2, ticket_type: t ? typeLabel(t.id) : "Event - Ticket type", sponsor: "", pool: "", note: "Blank cells use the form values" },
            { email: "partner@example.com", name: "Example Partner", qty: "", ticket_type: "", sponsor: s ? s.name : "Sponsor name", pool: "", note: "Sponsor picks that sponsor's pool" }]));
        });
        $("#cForm").addEventListener("submit", busy($("#cIssue"), function () {
          $("#cErr").textContent = "";
          var typeId = $("#cType").value, qty = Number($("#cQty").value), reason = $("#cReason").value, poolId = $("#cPool").value || null, note = $("#cNote").value.trim();
          if (!Number.isInteger(qty) || qty < 1 || qty > 10) return fail("Tickets per person must be between 1 and 10.");
          if (!reason) return fail("Choose a reason.");
          var reasonLabel = (reasons.find(function (x) { return x.code === reason; }) || {}).label || reason;
          var groups, skipped = 0;
          if (mode === "one") {
            if (!typeId) return fail("Choose a ticket type.");
            var em = $("#cEmail").value.trim().toLowerCase();
            if (!EMAIL_RE.test(em)) return fail("Enter a valid email for the recipient.");
            groups = [{ typeId: typeId, qty: qty, poolId: poolId, note: note, recipients: [{ email: em, name: $("#cName").value.trim() || null }] }];
          } else {
            if (!state.previewRaw) return fail("Upload a CSV file or paste rows, then preview the list.");
            resolve();
            groups = groupCompRows(state.preview, note);
            skipped = state.preview.filter(function (x) { return x.problem; }).length;
            if (!groups.length) return fail("No valid rows to issue.");
            if (state.preview.length - skipped > 500) return fail("Issue at most 500 people at a time.");
          }
          var poolErr = poolCheck(groups, pools); if (poolErr) return fail(poolErr);
          var people = 0, total = 0;
          groups.forEach(function (g) { people += g.recipients.length; total += g.recipients.length * g.qty; });
          return confirmAction({
            title: "Issue " + total + " comp ticket" + (total === 1 ? "" : "s") + "?", confirmLabel: "Issue comps", reason: false,
            message: (groups.length === 1 ? "<b>" + people + "</b> " + (people === 1 ? "person" : "people") + " get " + groups[0].qty + " x " + esc(typeLabel(groups[0].typeId)) + " at no charge." + (groups[0].poolId ? "<br>Pool: " + esc(poolName(pools, groups[0].poolId)) : "")
              : "<b>" + people + "</b> people in <b>" + groups.length + "</b> batches (one per ticket type, qty and pool):<br>" + groups.map(function (g) { return g.recipients.length + " x " + g.qty + " " + esc(typeLabel(g.typeId)) + (g.poolId ? " - " + esc(poolName(pools, g.poolId)) : ""); }).join("<br>")) +
              "<br>Reason: <b>" + esc(reasonLabel) + "</b>" + (skipped ? '<br><span class="err">' + skipped + " row" + (skipped === 1 ? "" : "s") + " with problems will be skipped.</span>" : "")
          }).then(function (ok) {
            if (!ok) return;
            // Batches go one after another; the first failure stops the rest so nothing is issued twice on a retry.
            var done = [], failed = null;
            return groups.reduce(function (p, g) {
              return p.then(function () {
                if (failed) return;
                return rpc("tix", "issue_comp2", { p_app: APP, p_ticket_type_id: g.typeId, p_qty: g.qty, p_reason_code: reason, p_note: g.note || null, p_pool_id: g.poolId, p_recipients: g.recipients })
                  .then(function (res) { done.push({ g: g, n: res && (res.issued_count || (res.tickets && res.tickets.length)) || g.recipients.length * g.qty }); }, function (e) { failed = { g: g, e: e }; });
              });
            }, Promise.resolve()).then(function () { return issuedDialog(done, failed, groups, skipped); }).then(function () { return VIEWS.comps(); });
          });
          function fail(m) { $("#cErr").textContent = m; }
        }));
        on("pNew", "click", function () { return editPool(null, sponsors); });
        $$("[data-pool-edit]", main).forEach(function (b) { on(b, "click", function () { return editPool(pools.find(function (p) { return p.id === b.dataset.poolEdit; }), sponsors); }); });
        return loadCompReport();
      });
  };
  function poolName(pools, id) { var p = pools.find(function (x) { return x.id === id; }); return p ? p.name : "-"; }
  function poolCheck(groups, pools) {
    var need = {};
    groups.forEach(function (g) { if (g.poolId) need[g.poolId] = (need[g.poolId] || 0) + g.recipients.length * g.qty; });
    var msg = "";
    Object.keys(need).forEach(function (id) {
      var p = pools.find(function (x) { return x.id === id; }); if (!p || msg) return;
      var left = (p.allotment || 0) - (p.used || 0);
      var g = groups.find(function (x) { return x.poolId === id && p.ticket_type_id && x.typeId !== p.ticket_type_id; });
      if (g) msg = "That pool is for " + typeLabel(p.ticket_type_id) + ". Pick that ticket type or a different pool.";
      else if (need[id] > left) msg = "Pool " + p.name + " has " + left + " left; this would issue " + need[id] + ".";
    });
    return msg;
  }
  function issuedDialog(done, failed, groups, skipped) {
    var n = done.reduce(function (a, d) { return a + d.n; }, 0);
    if (n) toast(n + " comp ticket" + (n === 1 ? "" : "s") + " issued");
    var left = failed ? groups.slice(groups.indexOf(failed.g)) : [];
    return openDialog({
      title: failed ? "Comps partly issued" : "Comps issued",
      body: (done.length ? "<p>" + done.map(function (d) { return d.n + " ticket" + (d.n === 1 ? "" : "s") + " - " + d.g.recipients.length + " x " + d.g.qty + " " + esc(typeLabel(d.g.typeId)); }).join("<br>") + "</p><p>Each person gets the tickets on their pass when they sign in with that email.</p>" : "") +
        (failed ? '<div class="notice warn" role="alert">Stopped at the batch for ' + esc(typeLabel(failed.g.typeId)) + ": " + esc(failed.e.message) + "<br>That batch and the " + (left.length - 1) + " after it were not sent. Download the rows not issued, fix them and upload that file, so nobody gets tickets twice.</div>" +
          '<div class="btns"><button type="button" class="btn" id="ciLeft">Download rows not issued</button></div>' : "") +
        (skipped ? '<p class="muted">' + skipped + " row(s) with problems were skipped. Fix them and upload those rows again.</p>" : ""),
      buttons: [{ label: "Done", value: "cancel", cls: "primary" }],
      focusButton: true,
      onOpen: function (b) {
        var btn = $("#ciLeft", b); if (!btn) return;
        btn.addEventListener("click", function () {
          var rows = []; left.forEach(function (g) { g.rows ? g.rows.forEach(function (x) { rows.push({ email: x.email, name: x.name, qty: x.qty, ticket_type: x.typeId, pool: x.poolId || "", note: x.note }); }) : g.recipients.forEach(function (x) { rows.push({ email: x.email, name: x.name, qty: g.qty, ticket_type: g.typeId, pool: g.poolId || "", note: g.note }); }); });
          download("concours-comps-not-issued-" + todayStr() + ".csv", toCSV([["email", "email"], ["name", "name"], ["qty", "qty"], ["ticket_type", "ticket_type"], ["pool", "pool"], ["note", "note"]], rows));
        });
      }
    });
  }
  function renderPreview(pools) {
    var p = state.preview || [], ok = p.filter(function (x) { return !x.problem; }).length, bad = p.length - ok, raw = state.previewRaw || {};
    var groups = groupCompRows(p, ""), dflt = ' <span class="hint">(form)</span>';
    function cell(val, fromFile) { return esc(val) + (fromFile ? "" : dflt); }
    $("#cPreview").innerHTML = '<p role="status"><b>' + ok + "</b> ready to issue" + (bad ? ", <b>" + bad + "</b> with problems (will be skipped)" : "") +
      (groups.length ? " - " + groups.length + " batch" + (groups.length === 1 ? "" : "es") + " (one per ticket type, qty and pool)" : "") + ".</p>" +
      (raw.unused && raw.unused.length ? '<p class="hint">Columns not used: ' + esc(raw.unused.join(", ")) + ". Known columns: " + CSV_COLS.join(", ") + ".</p>" : "") +
      '<div class="tablewrap"><table><thead><tr><th scope="col" class="num">Row</th><th scope="col">Email</th><th scope="col">Name</th><th scope="col" class="num">Qty</th><th scope="col">Ticket type</th><th scope="col">Pool</th><th scope="col">Sponsor</th><th scope="col">Note</th><th scope="col">Check</th></tr></thead><tbody>' +
      (p.length ? p.map(function (x) {
        return '<tr class="' + (x.problem ? "bad" : "") + '"><td class="num">' + x.row + "</td><td>" + esc(x.email || "-") + "</td><td>" + esc(x.name || "-") + '</td><td class="num">' + cell(isNaN(x.qty) ? "?" : x.qty, x.from.qty) +
          "</td><td>" + (x.typeId ? cell(typeLabel(x.typeId), x.from.type) : "-") + "</td><td>" + (x.poolId ? cell(poolName(pools, x.poolId), x.from.pool || x.from.sponsor) : "-") +
          "</td><td>" + esc(x.sponsor ? x.sponsor.name : "-") + "</td><td>" + (x.note ? cell(x.note, x.from.note) : "-") + "</td><td>" + (x.problem ? pill(x.problem, "bad wrap") : pill("OK", "ok")) + "</td></tr>";
      }).join("") : emptyRow(9, "The list is empty.")) +
      "</tbody></table></div>" + ' <p class="hint">(form) = taken from the form above because the cell was blank.</p>';
  }
  function renderPools(pools, sponsors) {
    var spName = function (id) { var x = sponsors && sponsors.find(function (s) { return s.id === id; }); return x ? x.name : "-"; };
    $("#pTable").innerHTML = '<div class="tablewrap"><table><thead><tr><th scope="col">Pool</th><th scope="col">Ticket type</th>' + (sponsors ? '<th scope="col">Sponsor</th>' : "") + '<th scope="col">Owner</th><th scope="col">Used</th><th scope="col" class="num">Left</th><th scope="col"><span class="sr">Actions</span></th></tr></thead><tbody>' +
      (pools.length ? pools.map(function (p) {
        return "<tr><td>" + esc(p.name) + "</td><td>" + esc(typeLabel(p.ticket_type_id)) + "</td>" + (sponsors ? "<td>" + esc(spName(p.sponsor_id)) + "</td>" : "") + "<td>" + esc(p.owner_email || "-") + "</td><td>" + meter(p.used || 0, p.allotment) +
          '</td><td class="num">' + n0(Math.max(0, (p.allotment || 0) - (p.used || 0))) + '</td><td><button type="button" class="btn ghost sm" data-pool-edit="' + esc(p.id) + '">Edit</button></td></tr>';
      }).join("") : emptyRow(sponsors ? 7 : 6, "No pools yet. Pools cap how many comps a sponsor or team can hand out.")) + "</tbody></table></div>";
  }
  /* sponsors: null when tix.sponsors is not switched on yet - the picker is then left out and sponsor_id is not sent. */
  function editPool(p, sponsors) {
    var d = p || {};
    return openDialog({
      title: p ? "Edit comp pool" : "New comp pool",
      body: '<div class="form">' + fld("f_name", "Pool name", "text", d.name, { required: true, wide: true, hint: "e.g. A. Lange & Sohne sponsor allotment" }) +
        fld("f_type", "Ticket type", "select", "", { html: typeOptions(d.ticket_type_id, "Any ticket type") }) +
        fld("f_allot", "Allotment", "number", d.allotment, { attrs: ' min="0" step="1"' }) + fld("f_owner", "Owner email", "email", d.owner_email, { hint: "Who manages this allotment" }) +
        (sponsors ? fld("f_sponsor", "Sponsor", "select", d.sponsor_id || "", { options: [["", "No sponsor (straight comps)"]].concat(sponsors.map(function (s) { return [s.id, s.name + (s.year ? " (" + s.year + ")" : "")]; })), hint: "Comps from this pool count as the sponsor's package" }) : "") +
        (p ? '<p class="hint wide">' + n0(d.used || 0) + " already used.</p>" : "") + "</div>",
      buttons: [{ label: "Save pool", value: "save" }, { label: "Cancel", value: "cancel", cls: "ghost" }],
      validate: function (b) {
        if (!v(b, "f_name")) return "Enter a pool name.";
        if (v(b, "f_allot") === "" || !isInt(v(b, "f_allot"), 0)) return "Enter the allotment as a whole number.";
        if (p && Number(v(b, "f_allot")) < (p.used || 0)) return "The allotment cannot be less than the " + p.used + " already used.";
        if (v(b, "f_owner") && !EMAIL_RE.test(v(b, "f_owner"))) return "Enter a valid owner email, or leave it blank.";
      },
      collect: function (b) {
        var o = { name: v(b, "f_name"), ticket_type_id: v(b, "f_type") || null, allotment: Number(v(b, "f_allot")), owner_email: (v(b, "f_owner") || "").toLowerCase() || null };
        if (sponsors) o.sponsor_id = v(b, "f_sponsor") || null;
        if (p) o.id = p.id; return o;
      }
    }).then(function (pool) {
      if (!pool) return;
      return rpc("tix", "admin_upsert_pool", { p_app: APP, p_pool: pool }).then(function () { toast("Pool saved"); return VIEWS.comps(); });
    });
  }
  function loadCompReport() {
    return Promise.all([
      rpc("tix", "admin_sales_summary", { p_app: APP }).catch(function () { return null; }),
      sel("tix", "comp_report", function (q) { return q.eq("app", APP).eq("kind", "comp").order("created_at", { ascending: false }).limit(500); })
    ]).then(function (r) {
      var s = r[0] || {}, rows = r[1] || [], by = s.by_type || [];
      var used = rows.filter(function (x) { return x.came_in; }).length;
      $("#cReport").innerHTML = '<div class="grid tiles">' + tile("Paid tickets", n0(by.reduce(function (a, x) { return a + (x.paid_qty || 0); }, 0))) +
        tile("Comp tickets", n0(by.reduce(function (a, x) { return a + (x.comp_qty || 0); }, 0))) + tile("Comps used", n0(used), "Scanned at a gate (last 500 comps)") +
        tile("Comp use rate", pct(ratio(used, rows.length))) + "</div>" +
        '<h3 style="margin:14px 0 6px">Paid vs comp by ticket type</h3><div class="tablewrap"><table><thead><tr><th scope="col">Event</th><th scope="col">Ticket type</th><th scope="col" class="num">Paid</th><th scope="col" class="num">Comp</th><th scope="col" class="num">Comp share</th></tr></thead><tbody>' +
        (by.length ? by.map(function (x) { return "<tr><td>" + esc(x.event) + "</td><td>" + esc(x.ticket_type) + '</td><td class="num">' + n0(x.paid_qty) + '</td><td class="num">' + n0(x.comp_qty) + '</td><td class="num">' + pct(ratio(x.comp_qty || 0, (x.paid_qty || 0) + (x.comp_qty || 0))) + "</td></tr>"; }).join("") : emptyRow(5, "No tickets yet.")) +
        '</tbody></table></div><h3 style="margin:14px 0 6px">Recent comps</h3><div class="tablewrap"><table><thead><tr><th scope="col">When</th><th scope="col">Recipient</th><th scope="col">Reason</th><th scope="col">Ticket</th><th scope="col">Status</th><th scope="col">Used</th></tr></thead><tbody>' +
        (rows.length ? rows.slice(0, 100).map(function (x) { return "<tr><td>" + fmtDT(x.created_at) + "</td><td>" + esc(x.recipient || "-") + "</td><td>" + esc(x.reason) + '</td><td class="mono">' + esc(x.serial || "-") + "</td><td>" + statusPill(x.status) + "</td><td>" + (x.came_in ? pill("Came in", "ok") : pill("Not yet")) + "</td></tr>"; }).join("") : emptyRow(6, "No comps issued yet.")) +
        "</tbody></table></div>";
    }).catch(function (e) { $("#cReport").innerHTML = errBlock(e); });
  }

  // ===================================================================================== 4. Orders
  VIEWS.orders = function () {
    return loadCatalog().then(function () {
      main.innerHTML = '<div class="view"><h1>Orders</h1><form id="oForm" class="btns" role="search"><div class="field" style="flex:1;min-width:240px"><label for="oQ">Find an order</label>' +
        '<input type="search" id="oQ" placeholder="Email, name, order number or ticket serial" value="' + esc(store.get("adm.oQ", "")) + '"></div><button class="btn" type="submit" id="oGo" style="align-self:flex-end">Search</button></form>' +
        '<div id="oList"></div><div id="oDetail"></div></div>';
      $("#oForm").addEventListener("submit", busy($("#oGo"), search));
      if (state.order) return openOrder(state.order);
      return search();
    });
  };
  function search() {
    var q = $("#oQ").value.trim(); store.set("adm.oQ", q);
    $("#oDetail").innerHTML = "";
    return rpc("tix", "admin_orders", { p_app: APP, p_q: q || null, p_limit: 100 }).then(function (rows) {
      rows = rows || [];
      $("#oList").innerHTML = '<div class="tablewrap"><table><caption class="sr">Orders</caption><thead><tr><th scope="col">Placed</th><th scope="col">Buyer</th><th scope="col">Status</th><th scope="col">Channel</th><th scope="col" class="num">Total</th><th scope="col">Payment ref</th><th scope="col"><span class="sr">Open</span></th></tr></thead><tbody>' +
        (rows.length ? rows.map(function (o) {
          return "<tr><td>" + fmtDT(o.created_at) + "</td><td>" + esc(o.buyer_name || "") + '<div class="muted">' + esc(o.buyer_email || "-") + "</div></td><td>" + statusPill(o.status) + "</td><td>" + esc(o.channel) +
            '</td><td class="num">' + money(o.total_cents) + '</td><td class="mono">' + esc(o.payment_ref || o.stripe_payment_intent || "-") + '</td><td><button type="button" class="btn ghost sm" data-order="' + esc(o.id) + '">Open</button></td></tr>';
        }).join("") : emptyRow(7, q ? "No orders match." : "No orders yet.")) + "</tbody></table></div>";
      $$("[data-order]").forEach(function (b) { on(b, "click", function () { return openOrder(b.dataset.order); }); });
    });
  }
  function openOrder(id) {
    state.order = id;
    return rpc("tix", "admin_order_detail", { p_order_id: id }).then(function (d) {
      d = d || {}; var o = d.order || {}, lines = d.lines || [], tickets = d.tickets || [], refunds = d.refunds || [];
      var refunded = refunds.filter(function (r) { return r.status !== "failed"; }).reduce(function (a, r) { return a + (r.amount_cents || 0); }, 0);
      var refundable = Math.max(0, (o.total_cents || 0) - refunded), paid = !!(o.stripe_payment_intent || o.payment_ref) && (o.total_cents || 0) > 0;
      $("#oDetail").innerHTML = '<section class="panel" aria-labelledby="hOrder"><div class="head"><div><h2 id="hOrder">Order ' + esc(String(o.id || id).slice(0, 8)) + "</h2>" +
        '<div class="muted">' + fmtDT(o.created_at) + " - " + esc(o.channel || "") + " - " + esc(o.buyer_name || "") + " " + esc(o.buyer_email || "") + "</div></div>" +
        '<div class="btns">' + statusPill(o.status) + '<button type="button" class="btn ghost sm" id="odResend">Resend pass email</button>' +
        '<button type="button" class="btn danger sm" id="odRefund"' + (paid && refundable > 0 ? "" : " disabled") + ">Refund</button>" +
        '<button type="button" class="btn ghost sm" id="odClose">Close</button></div></div>' +
        (paid ? "" : '<p class="hint">No card payment on this order (comp or free), so there is nothing to refund through Stripe. Use Remove on a ticket instead.</p>') +
        '<div class="grid tiles" style="margin:12px 0">' + tile("Subtotal", money(o.subtotal_cents)) + tile("Discount", money(o.discount_cents), o.promo_code ? "Code " + o.promo_code : "") + tile("Tax", money(o.tax_cents)) +
        tile("Fees", money(o.fees_cents)) + tile("Total", money(o.total_cents)) + tile("Refunded", money(refunded)) + "</div>" +
        '<p class="mono">Payment: ' + esc(o.payment_method || "-") + " - " + esc(o.stripe_payment_intent || o.payment_ref || "no payment ref") + "</p>" +
        '<h3 style="margin:12px 0 6px">Lines</h3><div class="tablewrap"><table><thead><tr><th scope="col">Ticket type</th><th scope="col" class="num">Qty</th><th scope="col" class="num">Each</th><th scope="col" class="num">Tax</th><th scope="col">GL code</th></tr></thead><tbody>' +
        (lines.length ? lines.map(function (l) { return "<tr><td>" + esc(l.name || typeLabel(l.ticket_type_id)) + '</td><td class="num">' + n0(l.qty) + '</td><td class="num">' + money(l.unit_cents) + '</td><td class="num">' + money(l.tax_cents) + '</td><td class="mono">' + esc(l.gl_code || (typeById(l.ticket_type_id) || {}).gl_code || "-") + "</td></tr>"; }).join("") : emptyRow(5, "No lines (older order or comp).")) +
        '</tbody></table></div><h3 style="margin:12px 0 6px">Tickets</h3><div class="tablewrap"><table><thead><tr><th scope="col">Serial</th><th scope="col">Pass</th><th scope="col">Type</th><th scope="col">Holder</th><th scope="col">Status</th><th scope="col">Scans</th><th scope="col">Actions</th></tr></thead><tbody>' +
        (tickets.length ? tickets.map(function (t) {
          var sc = t.scans || [], live = t.status === "issued" || t.status === "claimed";
          return '<tr><td class="mono">' + esc(t.serial) + '</td><td class="mono">' + esc(t.pass_serial || "-") + "</td><td>" + esc(t.type || typeLabel(t.ticket_type_id)) + "</td><td>" + esc(t.holder_name || "-") + "</td><td>" + statusPill(t.status) + (t.is_comp ? " " + pill("Comp") : "") +
            "</td><td>" + (sc.length ? sc.map(function (s) { return '<div class="hint">' + fmtDT(s.scanned_at) + " - " + esc(s.gate || "") + " - " + esc(s.result) + "</div>"; }).join("") : '<span class="muted">None</span>') +
            '</td><td><div class="btns">' +
            (live ? '<button type="button" class="btn ghost sm" data-t-act="move" data-t="' + esc(t.id) + '">Change type</button><button type="button" class="btn ghost sm" data-t-act="move_account" data-t="' + esc(t.id) + '">Move to account</button><button type="button" class="btn ghost sm" data-t-act="unlock_phone" data-t="' + esc(t.id) + '">Unlock phone</button><button type="button" class="btn ghost sm" data-t-act="remove" data-t="' + esc(t.id) + '">Remove</button>' : "") +
            (live && paid ? '<button type="button" class="btn ghost sm" data-t-act="refund" data-t="' + esc(t.id) + '">Refund ticket</button>' : "") +
            (t.pass_serial ? '<button type="button" class="btn ghost sm" data-t-act="revoke" data-t="' + esc(t.id) + '">Revoke pass</button>' : "") + "</div></td></tr>";
        }).join("") : emptyRow(7, "No tickets on this order.")) + "</tbody></table></div>" +
        (refunds.length ? '<h3 style="margin:12px 0 6px">Refunds</h3><div class="tablewrap"><table><thead><tr><th scope="col">When</th><th scope="col" class="num">Amount</th><th scope="col">Reason</th><th scope="col">Status</th></tr></thead><tbody>' +
          refunds.map(function (r) { return "<tr><td>" + fmtDT(r.created_at) + '</td><td class="num">' + money(r.amount_cents) + "</td><td>" + esc(r.reason) + "</td><td>" + statusPill(r.status) + "</td></tr>"; }).join("") + "</tbody></table></div>" : "") +
        "</section>";
      $("#oDetail").scrollIntoView({ block: "start" });
      on("odClose", "click", function () { state.order = null; $("#oDetail").innerHTML = ""; });
      on("odResend", "click", function () {
        // TODO(FUNCTIONS): no pass-email function in the contract yet. Hook it here (e.g. functions.invoke('pass-email', {order_id})).
        toast("Resending the pass email is not connected yet. The buyer can sign in to the app with " + (o.buyer_email || "their email") + " to see the pass.");
      });
      on("odRefund", "click", function () { return refundDialog({ order_id: o.id }, refundable, "this order"); });
      $$("[data-t-act]").forEach(function (b) {
        var t = tickets.find(function (x) { return x.id === b.dataset.t; });
        on(b, "click", function () { return ticketAction(b.dataset.tAct, t, o, refundable); });
      });
    });
  }
  function refundDialog(target, maxCents, what) {
    return openDialog({
      title: "Refund " + what,
      body: '<div class="notice warn">Money goes back to the buyer\'s card through Stripe and refunded tickets stop scanning straight away. This cannot be undone.</div>' +
        '<fieldset style="border:0;padding:0;margin:0"><legend class="lbl">Amount</legend><label class="check"><input type="radio" name="rfAmt" value="full" checked> Full refund (' + money(maxCents) + ' refundable)</label>' +
        '<label class="check"><input type="radio" name="rfAmt" value="part"> Partial refund</label></fieldset>' +
        fld("rfCents", "Partial amount (dollars)", "text", "", { attrs: ' inputmode="decimal"' }) +
        fld("rfReason", "Reason (required, saved in the audit log)", "textarea", "", { attrs: ' minlength="3" maxlength="500"', required: true }),
      buttons: [{ label: "Refund", value: "ok", cls: "danger" }, { label: "Cancel", value: "cancel", cls: "ghost" }],
      validate: function (b) {
        if ($("input[name=rfAmt]:checked", b).value === "part") {
          var c = toCents(v(b, "rfCents"));
          if (isNaN(c) || c <= 0) return "Enter the partial amount.";
          if (c > maxCents) return "That is more than the " + money(maxCents) + " left to refund.";
        }
        if (v(b, "rfReason").length < 3) return "Enter a reason (at least 3 characters).";
      },
      collect: function (b) { return { part: $("input[name=rfAmt]:checked", b).value === "part", cents: toCents(v(b, "rfCents")), reason: v(b, "rfReason") }; }
    }).then(function (r) {
      if (!r) return;
      var body = Object.assign({}, target, { reason: r.reason });
      if (r.part) body.amount_cents = r.cents;
      return confirmAction({ title: "Confirm refund", reason: false, danger: true, confirmLabel: "Yes, refund " + (r.part ? money(r.cents) : "in full"),
        message: "Refund <b>" + (r.part ? money(r.cents) : money(maxCents) + " (full)") + "</b> for " + esc(what) + ".<br>Reason: " + esc(r.reason) }).then(function (ok) {
        if (!ok) return;
        return callFunction("refund", body).then(function () { toast("Refund sent to Stripe"); return openOrder(state.order); });
      });
    });
  }
  function ticketAction(act, t, o, refundable) {
    if (act === "move_account") return moveTicketDialog(t, t.pass_serial, function () { return openOrder(state.order); });
    if (act === "refund") {
      var price = (typeById(t.ticket_type_id) || {}).price_cents;
      return refundDialog({ ticket_id: t.id }, Math.min(refundable, price == null ? refundable : price), "ticket " + t.serial);
    }
    if (act === "revoke") {
      return confirmAction({ title: "Revoke pass " + t.pass_serial + "?", danger: true, confirmLabel: "Revoke pass",
        message: "The pass QR on the holder's phone stops scanning at every gate. Its tickets are not refunded. The holder must re-open the app to get a fresh credential if you later restore it." })
        .then(function (reason) { if (!reason) return; return rpc("tix", "revoke", { p_serial: t.pass_serial, p_reason: reason }).then(function () { toast("Pass revoked"); return openOrder(state.order); }); });
    }
    var copy = {
      move: { title: "Move ticket " + t.serial, msg: "Switch this ticket to another ticket type. No money moves; refund or charge the difference separately.", label: "Move ticket", danger: false },
      remove: { title: "Remove ticket " + t.serial + "?", msg: "The ticket is voided and stops scanning. No money is refunded.", label: "Remove ticket", danger: true },
      unlock_phone: { title: "Unlock ticket " + t.serial + " from its phone?", msg: "Use this for a lost or new phone. The ticket leaves the current phone and gets a fresh claim code.", label: "Unlock", danger: true }
    }[act];
    var sameEvent = cat.types.filter(function (x) { var cur = typeById(t.ticket_type_id); return !cur || x.event_id === cur.event_id; });
    return openDialog({
      title: copy.title,
      body: '<div class="notice' + (copy.danger ? " warn" : "") + '">' + esc(copy.msg) + "</div>" +
        (act === "move" ? fld("mvType", "New ticket type", "select", "", { html: '<option value="">Choose</option>' + sameEvent.filter(function (x) { return x.id !== t.ticket_type_id; }).map(function (x) { return '<option value="' + esc(x.id) + '">' + esc(x.name) + "</option>"; }).join("") }) : "") +
        fld("acReason", "Reason (required, saved in the audit log)", "textarea", "", { required: true }),
      buttons: [{ label: copy.label, value: "ok", cls: copy.danger ? "danger" : "primary" }, { label: "Cancel", value: "cancel", cls: "ghost" }],
      validate: function (b) { if (act === "move" && !v(b, "mvType")) return "Choose the new ticket type."; if (v(b, "acReason").length < 3) return "Enter a reason (at least 3 characters)."; },
      collect: function (b) { return { reason: v(b, "acReason"), type: act === "move" ? v(b, "mvType") : null }; }
    }).then(function (r) {
      if (!r) return;
      return rpc("tix", "admin_change", { p_ticket_id: t.id, p_action: act, p_reason: r.reason, p_new_ticket_type_id: r.type }).then(function () { toast("Done"); return openOrder(state.order); });
    });
  }

  // ===================================================================================== 5. Promo codes
  VIEWS.promos = function () {
    return Promise.all([loadCatalog(), sel("tix", "promo_codes", function (q) { return q.eq("app", APP).order("code"); })]).then(function (r) {
      var codes = r[1] || [];
      main.innerHTML = '<div class="view"><div class="head"><h1>Promo codes</h1><button type="button" class="btn" id="prNew">New promo code</button></div>' +
        '<div class="tablewrap"><table><thead><tr><th scope="col">Code</th><th scope="col">Discount</th><th scope="col">Applies to</th><th scope="col">Uses</th><th scope="col">Window</th><th scope="col">Status</th><th scope="col"><span class="sr">Actions</span></th></tr></thead><tbody>' +
        (codes.length ? codes.map(function (c) {
          return '<tr><td class="mono">' + esc(c.code) + "</td><td>" + (c.pct_off ? c.pct_off + "% off" : money(c.cents_off) + " off") + "</td><td>" +
            (c.ticket_type_ids && c.ticket_type_ids.length ? c.ticket_type_ids.map(function (id) { return esc(typeLabel(id)); }).join("<br>") : "All ticket types") +
            "</td><td>" + meter(c.used || 0, c.max_uses) + "</td><td>" + (c.starts || c.ends ? fmtD(c.starts) + " to " + fmtD(c.ends) : "Any time") + "</td><td>" + (c.active ? pill("Active", "ok") : pill("Off")) +
            '</td><td><button type="button" class="btn ghost sm" data-promo="' + esc(c.code) + '">Edit</button></td></tr>';
        }).join("") : emptyRow(7, "No promo codes yet.")) + "</tbody></table></div></div>";
      on("prNew", "click", function () { return editPromo(null); });
      $$("[data-promo]").forEach(function (b) { on(b, "click", function () { return editPromo(codes.find(function (c) { return c.code === b.dataset.promo; })); }); });
    });
  };
  function editPromo(c) {
    var d = c || { active: true, ticket_type_ids: [] }, draft = null;
    function form(x) {
      var ids = x.ticket_type_ids || [];
      return {
        title: c ? "Edit promo code " + c.code : "New promo code", wide: true,
        body: '<div class="form">' + fld("f_code", "Code", "text", x.code, { required: true, disabled: !!c, hint: "Letters and numbers, 3 to 32 characters. Not case sensitive." }) +
          fld("f_dtype", "Discount type", "select", x.cents_off ? "amount" : "percent", { options: [["percent", "Percent off"], ["amount", "Dollars off"]] }) +
          fld("f_dval", "Discount", "text", x.cents_off ? dollars(x.cents_off) : (x.pct_off || ""), { attrs: ' inputmode="decimal"', hint: "e.g. 20 for 20% or $20" }) +
          fld("f_maxu", "Most uses", "number", x.max_uses, { attrs: ' min="1" step="1"', hint: "Blank for no limit" }) +
          fld("f_start", "Starts", "datetime-local", toLocalInput(x.starts)) + fld("f_end", "Ends", "datetime-local", toLocalInput(x.ends)) +
          fld("f_active", "Active", "check", x.active) +
          '<fieldset class="wide" style="border:1px solid var(--line);border-radius:8px;padding:10px"><legend class="lbl">Applies to (none ticked = all ticket types)</legend>' +
          cat.types.map(function (t) { return '<label class="check"><input type="checkbox" name="f_tt" value="' + esc(t.id) + '"' + (ids.indexOf(t.id) >= 0 ? " checked" : "") + "> " + esc(typeLabel(t.id)) + "</label>"; }).join("") + "</fieldset></div>",
        buttons: [{ label: "Save promo code", value: "save" }, { label: "Cancel", value: "cancel", cls: "ghost" }],
        validate: function (b) {
          if (!/^[A-Za-z0-9_-]{3,32}$/.test(v(b, "f_code"))) return "The code must be 3 to 32 letters, numbers, dashes or underscores.";
          var val = Number(v(b, "f_dval"));
          if (v(b, "f_dtype") === "percent") { if (!Number.isInteger(val) || val < 1 || val > 100) return "Percent off must be a whole number from 1 to 100."; }
          else { var cents = toCents(v(b, "f_dval")); if (isNaN(cents) || cents <= 0) return "Enter the dollars off."; }
          if (!isInt(v(b, "f_maxu"), 1)) return "Most uses must be a whole number, or blank.";
          var s = v(b, "f_start"), e = v(b, "f_end"); if (s && e && new Date(e) <= new Date(s)) return "The end must be after the start.";
        },
        collect: function (b) {
          var pctMode = v(b, "f_dtype") === "percent";
          return { code: v(b, "f_code").toUpperCase(), pct_off: pctMode ? Number(v(b, "f_dval")) : null, cents_off: pctMode ? null : toCents(v(b, "f_dval")),
            ticket_type_ids: $$("input[name=f_tt]:checked", b).map(function (i) { return i.value; }), max_uses: intOrNull(v(b, "f_maxu")),
            starts: fromLocalInput(v(b, "f_start")), ends: fromLocalInput(v(b, "f_end")), active: v(b, "f_active") };
        }
      };
    }
    function loop() {
      return openDialog(form(draft || d)).then(function (x) {
        if (!x) return;
        draft = x;
        return confirmAction({ title: "Save promo code " + x.code + "?", confirmLabel: "Save promo code",
          message: "Anyone with <b>" + esc(x.code) + "</b> gets " + (x.pct_off ? x.pct_off + "% off" : money(x.cents_off) + " off") + (x.ticket_type_ids.length ? " the ticked ticket types" : " every ticket type") +
            (x.max_uses ? ", up to " + x.max_uses + " uses" : ", with no use limit") + (x.active ? "." : ". The code is off until you make it active.") }).then(function (reason) {
          if (reason === null) return loop();
          return rpc("tix", "admin_upsert_promo", { p_app: APP, p_promo: Object.assign({}, x, { _reason: reason }) }).then(function () { toast("Promo code saved"); return VIEWS.promos(); });
        });
      });
    }
    return loop();
  }

  // ===================================================================================== 6. Ops: parking, trolleys, vehicles
  var LOT_STATUS = [["open", "Open"], ["filling", "Filling up"], ["full", "Full"], ["closed", "Closed"]];
  VIEWS.ops = function () {
    return Promise.all([rpc("ops", "live", { p_app: APP }), sel("ops", "vehicles", function (q) { return q.select("id,name,route_id,tracker_kind").eq("app", APP).order("name"); /* never the token hash */ })]).then(function (r) {
      var live = r[0] || {}, lots = live.lots || [], routes = live.routes || [], vehicles = r[1] || [], pos = {};
      (live.vehicles || []).forEach(function (p) { pos[p.vehicle_id || p.id] = p; });
      main.innerHTML = '<div class="view"><h1>Parking and trolleys</h1>' +
        '<section class="panel" aria-labelledby="hLots"><div class="head"><h2 id="hLots">Parking lots</h2><button type="button" class="btn ghost" id="lotNew">Add lot</button></div>' +
        '<p class="hint">Status shows to guests in the app straight away.</p><div class="tablewrap"><table><thead><tr><th scope="col">Lot</th><th scope="col" class="num">Capacity</th><th scope="col">Status</th><th scope="col">Note for guests</th><th scope="col">Updated</th><th scope="col"><span class="sr">Actions</span></th></tr></thead><tbody>' +
        (lots.length ? lots.map(function (l) {
          return '<tr><td>' + esc(l.name) + '</td><td class="num">' + (l.capacity == null ? "-" : n0(l.capacity)) + '</td><td><label class="sr" for="ls_' + esc(l.id) + '">Status for ' + esc(l.name) + '</label><select id="ls_' + esc(l.id) + '">' +
            LOT_STATUS.map(function (s) { return '<option value="' + s[0] + '"' + (s[0] === l.status ? " selected" : "") + ">" + s[1] + "</option>"; }).join("") +
            '</select></td><td><label class="sr" for="ln_' + esc(l.id) + '">Note for ' + esc(l.name) + '</label><input type="text" id="ln_' + esc(l.id) + '" value="' + esc(l.note || "") + '" maxlength="140"></td><td>' + fmtDT(l.updated_at) +
            '</td><td><div class="btns"><button type="button" class="btn sm" data-lot-set="' + esc(l.id) + '">Update</button><button type="button" class="btn ghost sm" data-lot-edit="' + esc(l.id) + '">Edit</button></div></td></tr>';
        }).join("") : emptyRow(6, "No lots yet.")) + "</tbody></table></div></section>" +
        '<section class="panel" aria-labelledby="hRoutes"><div class="head"><h2 id="hRoutes">Trolley routes</h2><button type="button" class="btn ghost" id="rtNew">Add route</button></div><div class="tablewrap"><table><thead><tr><th scope="col">Route</th><th scope="col" class="num">Every</th><th scope="col">Runs</th><th scope="col" class="num">Path points</th><th scope="col">Stops</th><th scope="col"><span class="sr">Actions</span></th></tr></thead><tbody>' +
        (routes.length ? routes.map(function (rt) {
          return '<tr><td><span aria-hidden="true" style="display:inline-block;width:12px;height:12px;border-radius:3px;background:' + esc(rt.color || "#003057") + '"></span> ' + esc(rt.name) + '</td><td class="num">' + (rt.headway_min ? rt.headway_min + " min" : "-") + "</td><td>" + esc(rt.runs || "-") +
            '</td><td class="num">' + n0((rt.path || []).length) + "</td><td>" + esc((rt.stops || []).slice().sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); }).map(function (s) { return s.name; }).join(", ") || "-") +
            '</td><td><button type="button" class="btn ghost sm" data-route="' + esc(rt.id) + '">Edit</button></td></tr>';
        }).join("") : emptyRow(6, "No routes yet.")) + "</tbody></table></div></section>" +
        '<section class="panel" aria-labelledby="hVeh"><div class="head"><h2 id="hVeh">Vehicles</h2><button type="button" class="btn ghost" id="vhNew">Add vehicle</button></div>' +
        '<p class="hint">Each vehicle reports its position with a tracker token, from the driver\'s phone or a GPS device.</p><div class="tablewrap"><table><thead><tr><th scope="col">Vehicle</th><th scope="col">Route</th><th scope="col">Tracker</th><th scope="col">Last position</th><th scope="col"><span class="sr">Actions</span></th></tr></thead><tbody>' +
        (vehicles.length ? vehicles.map(function (vh) {
          var rt = routes.find(function (x) { return x.id === vh.route_id; }), p = pos[vh.id];
          return "<tr><td>" + esc(vh.name) + "</td><td>" + esc(rt ? rt.name : "-") + "</td><td>" + (vh.tracker_kind === "gps_device" ? "GPS device" : "Driver phone") + "</td><td>" + (p ? fmtDT(p.at) : '<span class="muted">Not reporting</span>') +
            '</td><td><button type="button" class="btn ghost sm" data-veh-rotate="' + esc(vh.id) + '">Issue new token</button></td></tr>';
        }).join("") : emptyRow(5, "No vehicles yet.")) + "</tbody></table></div></section></div>";
      $$("[data-lot-set]").forEach(function (b) {
        on(b, "click", function () {
          var id = b.dataset.lotSet;
          return rpc("ops", "set_lot_status", { p_lot_id: id, p_status: $("#ls_" + CSS.escape(id)).value, p_note: $("#ln_" + CSS.escape(id)).value.trim() || null }).then(function () { toast("Lot updated"); });
        });
      });
      $$("[data-lot-edit]").forEach(function (b) { on(b, "click", function () { return editLot(lots.find(function (l) { return l.id === b.dataset.lotEdit; })); }); });
      on("lotNew", "click", function () { return editLot(null); });
      $$("[data-route]").forEach(function (b) { on(b, "click", function () { return editRoute(routes.find(function (x) { return x.id === b.dataset.route; })); }); });
      on("rtNew", "click", function () { return editRoute(null); });
      on("vhNew", "click", function () { return addVehicle(routes); });
      $$("[data-veh-rotate]").forEach(function (b) { on(b, "click", function () { return rotateVehicle(vehicles.find(function (x) { return x.id === b.dataset.vehRotate; })); }); });
    });
  };
  function latOk(s) { var n = Number(s); return s !== "" && isFinite(n) && n >= -90 && n <= 90; }
  function lngOk(s) { var n = Number(s); return s !== "" && isFinite(n) && n >= -180 && n <= 180; }
  function editLot(l) {
    var d = l || { status: "open" };
    return openDialog({
      title: l ? "Edit lot " + l.name : "Add parking lot",
      body: '<div class="form">' + fld("f_name", "Name", "text", d.name, { required: true, wide: true }) + fld("f_lat", "Latitude", "text", d.lat, { attrs: ' inputmode="decimal"', hint: "e.g. 41.4775" }) +
        fld("f_lng", "Longitude", "text", d.lng, { attrs: ' inputmode="decimal"', hint: "e.g. -71.3362" }) + fld("f_cap", "Capacity (cars)", "number", d.capacity, { attrs: ' min="0" step="1"' }) +
        fld("f_status", "Status", "select", d.status, { options: LOT_STATUS }) + fld("f_note", "Note for guests", "text", d.note, { wide: true, attrs: ' maxlength="140"' }) + "</div>",
      buttons: [{ label: "Save lot", value: "save" }, { label: "Cancel", value: "cancel", cls: "ghost" }],
      validate: function (b) {
        if (!v(b, "f_name")) return "Enter a name.";
        if (!latOk(v(b, "f_lat")) || !lngOk(v(b, "f_lng"))) return "Enter a valid latitude and longitude.";
        if (!isInt(v(b, "f_cap"), 0)) return "Capacity must be a whole number.";
      },
      collect: function (b) { var o = { name: v(b, "f_name"), lat: Number(v(b, "f_lat")), lng: Number(v(b, "f_lng")), capacity: intOrNull(v(b, "f_cap")), status: v(b, "f_status"), note: v(b, "f_note") || null }; if (l) o.id = l.id; return o; }
    }).then(function (lot) { if (!lot) return; return rpc("ops", "admin_upsert_lot", { p_app: APP, p_lot: lot }).then(function () { toast("Lot saved"); return VIEWS.ops(); }); });
  }
  function editRoute(rt) {
    var d = rt || { color: "#003057", path: [], stops: [] };
    var path = (d.path || []).map(function (p) { return [p[0], p[1]]; });
    var stops = (d.stops || []).slice().sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); }).map(function (s) { return { id: s.id, name: s.name, lat: s.lat, lng: s.lng }; });
    var origStopIds = stops.filter(function (s) { return s.id; }).map(function (s) { return s.id; });
    function readRows(b) {
      // The "No points" / "No stops" placeholder rows have no inputs, so they are skipped.
      path = $$("#rpRows tr", b).filter(function (tr) { return $("[data-k=lat]", tr); }).map(function (tr) { return [$("[data-k=lat]", tr).value.trim(), $("[data-k=lng]", tr).value.trim()]; });
      stops = $$("#rsRows tr", b).filter(function (tr) { return $("[data-k=name]", tr); }).map(function (tr) { return { id: tr.dataset.id || undefined, name: $("[data-k=name]", tr).value.trim(), lat: $("[data-k=lat]", tr).value.trim(), lng: $("[data-k=lng]", tr).value.trim() }; });
    }
    function rows(b) {
      $("#rpRows", b).innerHTML = path.map(function (p, i) {
        return '<tr><td class="num">' + (i + 1) + '</td><td><label class="sr" for="rp_lat' + i + '">Point ' + (i + 1) + ' latitude</label><input id="rp_lat' + i + '" data-k="lat" type="text" inputmode="decimal" value="' + esc(p[0]) + '"></td>' +
          '<td><label class="sr" for="rp_lng' + i + '">Point ' + (i + 1) + ' longitude</label><input id="rp_lng' + i + '" data-k="lng" type="text" inputmode="decimal" value="' + esc(p[1]) + '"></td>' +
          '<td><div class="btns"><button type="button" class="btn ghost sm" data-up="' + i + '" aria-label="Move point ' + (i + 1) + ' up">Up</button><button type="button" class="btn ghost sm" data-rm-pt="' + i + '" aria-label="Remove point ' + (i + 1) + '">Remove</button></div></td></tr>';
      }).join("") || '<tr><td colspan="4" class="empty">No points. Add them in driving order.</td></tr>';
      $("#rsRows", b).innerHTML = stops.map(function (s, i) {
        return '<tr data-id="' + esc(s.id || "") + '"><td class="num">' + (i + 1) + '</td><td><label class="sr" for="rs_n' + i + '">Stop ' + (i + 1) + ' name</label><input id="rs_n' + i + '" data-k="name" type="text" value="' + esc(s.name) + '"></td>' +
          '<td><label class="sr" for="rs_a' + i + '">Stop ' + (i + 1) + ' latitude</label><input id="rs_a' + i + '" data-k="lat" type="text" inputmode="decimal" value="' + esc(s.lat) + '"></td>' +
          '<td><label class="sr" for="rs_o' + i + '">Stop ' + (i + 1) + ' longitude</label><input id="rs_o' + i + '" data-k="lng" type="text" inputmode="decimal" value="' + esc(s.lng) + '"></td>' +
          '<td><button type="button" class="btn ghost sm" data-rm-st="' + i + '" aria-label="Remove stop ' + (i + 1) + '">Remove</button></td></tr>';
      }).join("") || '<tr><td colspan="5" class="empty">No stops yet.</td></tr>';
      drawMap(b);
    }
    var map = null;
    // Leaflet is optional: only drawn if a page-level copy is present (vendor has none as of 2026-10-16).
    function drawMap(b) {
      if (!window.L) return;
      var el = $("#rMap", b); el.hidden = false;
      if (!map) { map = L.map(el).setView([41.48, -71.32], 13); L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "OpenStreetMap" }).addTo(map); map.on("click", function (e) { readRows(b); path.push([e.latlng.lat.toFixed(6), e.latlng.lng.toFixed(6)]); rows(b); }); }
      map.eachLayer(function (ly) { if (!(ly instanceof L.TileLayer)) map.removeLayer(ly); });
      var pts = path.filter(function (p) { return latOk(String(p[0])) && lngOk(String(p[1])); }).map(function (p) { return [Number(p[0]), Number(p[1])]; });
      if (pts.length) { L.polyline(pts, { color: $("#f_color", b).value }).addTo(map); map.fitBounds(pts); }
      stops.forEach(function (s) { if (latOk(String(s.lat)) && lngOk(String(s.lng))) L.circleMarker([Number(s.lat), Number(s.lng)], { radius: 6 }).bindTooltip(s.name || "").addTo(map); });
    }
    return openDialog({
      title: rt ? "Edit route " + rt.name : "Add trolley route", wide: true,
      body: '<div class="form">' + fld("f_name", "Route name", "text", d.name, { required: true }) + fld("f_color", "Colour on the map", "color", d.color || "#003057") +
        fld("f_head", "Every (minutes)", "number", d.headway_min, { attrs: ' min="1" max="240" step="1"' }) + fld("f_runs", "Runs", "text", d.runs, { hint: "e.g. Sat and Sun, 9:00 AM to 5:00 PM" }) + "</div>" +
        '<div id="rMap" style="height:300px;border-radius:10px" hidden></div>' +
        '<h3>Path</h3><p class="hint">Points in driving order. Paste lines of "latitude, longitude" to replace the list.</p><div class="tablewrap"><table><thead><tr><th scope="col" class="num">#</th><th scope="col">Latitude</th><th scope="col">Longitude</th><th scope="col"><span class="sr">Actions</span></th></tr></thead><tbody id="rpRows"></tbody></table></div>' +
        '<div class="btns"><button type="button" class="btn ghost sm" id="rpAdd">Add point</button></div>' + fld("rpPaste", "Paste points", "textarea", "") + '<div class="btns"><button type="button" class="btn ghost sm" id="rpUse">Use pasted points</button></div>' +
        '<h3>Stops</h3><div class="tablewrap"><table><thead><tr><th scope="col" class="num">#</th><th scope="col">Name</th><th scope="col">Latitude</th><th scope="col">Longitude</th><th scope="col"><span class="sr">Actions</span></th></tr></thead><tbody id="rsRows"></tbody></table></div>' +
        '<div class="btns"><button type="button" class="btn ghost sm" id="rsAdd">Add stop</button></div>',
      buttons: [{ label: "Save route", value: "save" }, { label: "Cancel", value: "cancel", cls: "ghost" }],
      onOpen: function (b) {
        rows(b);
        b.addEventListener("click", function (e) {
          var t = e.target.closest("button"); if (!t) return;
          readRows(b);
          if (t.id === "rpAdd") path.push(["", ""]);
          else if (t.id === "rsAdd") stops.push({ name: "", lat: "", lng: "" });
          else if (t.id === "rpUse") {
            var pts = $("#rpPaste", b).value.split(/\r?\n/).map(function (l) { return l.split(/[,\s]+/).filter(Boolean); }).filter(function (p) { return p.length >= 2; }).map(function (p) { return [p[0], p[1]]; });
            if (pts.length) { path = pts; $("#rpPaste", b).value = ""; }
          } else if (t.dataset.up) { var i = Number(t.dataset.up); if (i > 0) { var x = path[i - 1]; path[i - 1] = path[i]; path[i] = x; } }
          else if (t.dataset.rmPt) path.splice(Number(t.dataset.rmPt), 1);
          else if (t.dataset.rmSt) stops.splice(Number(t.dataset.rmSt), 1);
          else return;
          rows(b);
        });
      },
      validate: function (b) {
        readRows(b);
        if (!v(b, "f_name")) return "Enter a route name.";
        if (!isInt(v(b, "f_head"), 1, 240)) return "Every (minutes) must be a whole number from 1 to 240.";
        if (path.length < 2) return "Add at least two path points.";
        var bad = path.findIndex(function (p) { return !latOk(String(p[0])) || !lngOk(String(p[1])); });
        if (bad >= 0) return "Path point " + (bad + 1) + " needs a valid latitude and longitude.";
        var bs = stops.findIndex(function (s) { return !s.name || !latOk(String(s.lat)) || !lngOk(String(s.lng)); });
        if (bs >= 0) return "Stop " + (bs + 1) + " needs a name, latitude and longitude.";
      },
      collect: function (b) {
        var o = { name: v(b, "f_name"), color: v(b, "f_color"), headway_min: intOrNull(v(b, "f_head")), runs: v(b, "f_runs") || null, path: path.map(function (p) { return [Number(p[0]), Number(p[1])]; }) };
        if (rt) o.id = rt.id; return o;
      }
    }).then(function (route) {
      if (!route) return;
      var keep = stops.filter(function (s) { return s.id; }).map(function (s) { return s.id; });
      var removed = origStopIds.filter(function (id) { return keep.indexOf(id) < 0; });
      var step = removed.length ? confirmAction({ title: "Remove " + removed.length + " stop" + (removed.length === 1 ? "" : "s") + "?", reason: false, danger: true, confirmLabel: "Save and remove",
        message: "Guests will no longer see " + (removed.length === 1 ? "that stop" : "those stops") + " on the trolley map." }) : Promise.resolve(true);
      return step.then(function (ok) {
        if (!ok) return;
        return rpc("ops", "admin_upsert_route", { p_app: APP, p_route: route }).then(function (saved) {
          var routeId = (saved && saved.id) || route.id;
          var calls = stops.map(function (s, i) { var st = { route_id: routeId, name: s.name, lat: Number(s.lat), lng: Number(s.lng), seq: i + 1 }; if (s.id) st.id = s.id; return function () { return rpc("ops", "admin_upsert_stop", { p_stop: st }); }; })
            .concat(removed.map(function (id) { return function () { return rpc("ops", "admin_upsert_stop", { p_stop: { id: id, _delete: true } }); }; }));
          return calls.reduce(function (p, fn) { return p.then(fn); }, Promise.resolve()).then(function () { toast("Route saved"); return VIEWS.ops(); });
        });
      });
    });
  }
  /* The tracker token is returned once by the server (only its hash is stored) and is never kept in page state. */
  /* 2026-10-23 DRIVER TRACKER: the driver link is <site>/track/#v=<vehicle id>&t=<token>. The hash never reaches a server
     (the track page moves it into sessionStorage and clears it), and the QR lets the driver's phone open it with one scan. */
  function trackerLink(vehicleId, token) {
    return new URL("../track/", location.href).href + "#v=" + encodeURIComponent(vehicleId) + "&t=" + encodeURIComponent(token);
  }
  var passLib = null;
  function loadPassLib() {   // shared/pass.js holds the QR helper (renderQR over the vendored qrcode-generator)
    if (window.AudrainPass) return Promise.resolve(window.AudrainPass);
    if (!passLib) passLib = new Promise(function (res, rej) {
      var s = document.createElement("script"); s.src = "../shared/pass.js"; s.async = true;
      s.onload = function () { window.AudrainPass ? res(window.AudrainPass) : rej(new Error("QR helper missing")); };
      s.onerror = function () { passLib = null; rej(new Error("QR helper failed to load")); };
      document.head.appendChild(s);
    });
    return passLib;
  }
  function copyFrom(b, btnId, boxId, outId, text, what) {
    $("#" + btnId, b).addEventListener("click", function () {
      var out = $("#" + outId, b), done = function () { out.textContent = what + " copied"; };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { out.textContent = "Copy failed. Select the " + what.toLowerCase() + " and copy it by hand."; });
      else { var r = document.createRange(); r.selectNodeContents($("#" + boxId, b)); getSelection().removeAllRanges(); getSelection().addRange(r); out.textContent = "Selected. Press Ctrl+C to copy."; }
    });
  }
  function showToken(name, token, vehicleId, kind) {
    var link = vehicleId ? trackerLink(vehicleId, token) : null, gps = kind === "gps_device";
    var linkPart = link ? '<div class="trkbox"><div class="trkqr" id="trkQr" aria-live="polite"><span class="hint">Drawing QR...</span></div><div class="trkside">' +
        '<p class="hint"><b>Driver phone:</b> scan this QR with the phone that rides on the trolley, then tap Start. The link opens the tracker page; the key is not kept in the address bar.</p>' +
        '<div class="tokenbox" id="linkVal">' + esc(link) + '</div><div class="btns"><button type="button" class="btn" id="linkCopy">Copy link</button><span id="linkCopied" role="status" class="hint"></span></div></div></div>' : "";
    var tokenPart = '<p class="hint">' + (gps ? "<b>GPS device:</b> load the vehicle id and token, and POST positions to " + esc((window.SB_CONFIG && window.SB_CONFIG.url || "") + "/functions/v1/ops-position") + "." : "Token on its own (for a GPS device):") + "</p>" +
        (vehicleId ? '<div class="hint">Vehicle id <span class="mono">' + esc(vehicleId) + "</span></div>" : "") +
        '<div class="tokenbox" id="tokenVal">' + esc(token) + '</div><div class="btns"><button type="button" class="btn ghost" id="tokenCopy">Copy token</button><span id="tokenCopied" role="status" class="hint"></span></div>';
    return openDialog({
      title: "Tracker for " + name,
      wide: !!link,
      body: '<div class="notice warn" role="alert"><b>Save this now. The token' + (link ? " and the driver link are" : " is") + ' shown only once</b> and cannot be looked up again. Anyone with it can move this vehicle on the guest map, so send it only to the driver or load it into the GPS device. Lost it? Issue a new token.</div>' +
        (gps ? tokenPart + linkPart : linkPart + tokenPart),
      buttons: [{ label: "I have saved it", value: "cancel", cls: "ghost" }],
      focusButton: true,
      onOpen: function (b) {
        copyFrom(b, "tokenCopy", "tokenVal", "tokenCopied", token, "Token");
        if (!link) return;
        copyFrom(b, "linkCopy", "linkVal", "linkCopied", link, "Link");
        loadPassLib().then(function (P) {
          var box = $("#trkQr", b); if (!box) return;   // dialog already closed
          return P.renderQR(box, link, { size: 220, ecc: "M", label: "QR code of the driver link for " + name }).then(function (c) { c.dataset.text = link; });
        }).catch(function () { var box = $("#trkQr", b); if (box) box.innerHTML = '<span class="hint">The QR could not be drawn. Copy the link and send it to the driver instead.</span>'; });
      }
    }).then(function () { $("#dlgBody").innerHTML = ""; token = null; link = null; });
  }
  function addVehicle(routes) {
    return openDialog({
      title: "Add vehicle",
      body: '<div class="form">' + fld("f_name", "Name", "text", "", { required: true, hint: "e.g. Trolley 3" }) +
        fld("f_route", "Route", "select", "", { options: [["", "No route yet"]].concat(routes.map(function (r) { return [r.id, r.name]; })) }) +
        fld("f_kind", "Tracker", "select", "driver_phone", { options: [["driver_phone", "Driver's phone"], ["gps_device", "GPS device"]] }) + "</div>",
      buttons: [{ label: "Create vehicle", value: "save" }, { label: "Cancel", value: "cancel", cls: "ghost" }],
      validate: function (b) { if (!v(b, "f_name")) return "Enter a name."; },
      collect: function (b) { return { name: v(b, "f_name"), route_id: v(b, "f_route") || null, tracker_kind: v(b, "f_kind") }; }
    }).then(function (vh) {
      if (!vh) return;
      return rpc("ops", "admin_upsert_vehicle", { p_app: APP, p_vehicle: vh }).then(function (res) {
        var token = res && res.tracker_token;
        return (token ? showToken(vh.name, token, res.id, res.tracker_kind || vh.tracker_kind) : Promise.resolve(toast("Vehicle saved"))).then(function () { return VIEWS.ops(); });
      });
    });
  }
  function rotateVehicle(vh) {
    return confirmAction({ title: "Issue a new token for " + vh.name + "?", danger: true, confirmLabel: "Issue new token",
      message: "The current token stops working straight away. The driver's phone or GPS device must be given the new token before it reports again." })
      .then(function (reason) {
        if (!reason) return;
        return rpc("ops", "admin_upsert_vehicle", { p_app: APP, p_vehicle: { id: vh.id, rotate_token: true, _reason: reason } }).then(function (res) {
          return res && res.tracker_token ? showToken(vh.name, res.tracker_token, res.id || vh.id, res.tracker_kind || vh.tracker_kind) : toast("Token reset");
        });
      });
  }

  // ===================================================================================== 7. Exports
  /* Column order is what finance reconciles against Stripe: payment ref and GL code on every money row. */
  var EXPORTS = {
    orders: { label: "Orders", cols: [["order_id", "order_id"], ["created_at", "created_at"], ["status", "status"], ["channel", "channel"], ["buyer_name", "buyer_name"], ["buyer_email", "buyer_email"],
      ["subtotal", "subtotal_cents", "$"], ["discount", "discount_cents", "$"], ["tax", "tax_cents", "$"], ["fees", "fees_cents", "$"], ["total", "total_cents", "$"], ["refunded", "refunded_cents", "$"],
      ["payment_method", "payment_method"], ["stripe_payment_ref", function (r) { return r.stripe_payment_intent || r.payment_ref; }], ["gl_codes", function (r) { return Array.isArray(r.gl_codes) ? r.gl_codes.join(";") : r.gl_codes; }],
      ["promo_code", "promo_code"], ["utm_campaign", "utm_campaign"], ["entity", "entity"]] },
    tickets: { label: "Tickets", cols: [["ticket_id", "ticket_id"], ["serial", "serial"], ["pass_serial", "pass_serial"], ["order_id", "order_id"], ["event", "event"], ["ticket_type", "ticket_type"], ["kind", "kind"],
      ["gl_code", "gl_code"], ["status", "status"], ["is_comp", "is_comp"], ["unit_price", "unit_cents", "$"], ["tax", "tax_cents", "$"], ["holder_name", "holder_name"], ["buyer_email", "buyer_email"],
      ["issued_at", "issued_at"], ["stripe_payment_ref", function (r) { return r.stripe_payment_intent || r.payment_ref; }], ["came_in", "came_in"]] },
    comps: { label: "Comps", cols: [["comp_id", "comp_id"], ["created_at", "created_at"], ["issued_by", "issued_by_email"], ["recipient_email", "recipient_email"], ["recipient_name", "recipient_name"],
      ["reason_code", "reason_code"], ["note", "note"], ["pool", "pool"], ["event", "event"], ["ticket_type", "ticket_type"], ["gl_code", "gl_code"], ["face_value", "face_value_cents", "$"],
      ["serial", "serial"], ["status", "status"], ["came_in", "came_in"], ["stripe_payment_ref", function () { return ""; }]] },
    scans: { label: "Scans", cols: [["scan_id", "scan_id"], ["scanned_at", "scanned_at"], ["device_time", "device_time"], ["synced_at", "synced_at"], ["gate", "gate"], ["zone", "zone"], ["serial", "serial"],
      ["event", "event"], ["ticket_type", "ticket_type"], ["gl_code", "gl_code"], ["result", "result"], ["method", "method"], ["offline", "offline"], ["device", "device"], ["scanned_by", "scanned_by_email"],
      ["order_id", "order_id"], ["stripe_payment_ref", function (r) { return r.stripe_payment_intent || r.payment_ref; }]] }
  };
  function csvCell(val) {
    if (val == null) return "";
    var s = typeof val === "object" ? JSON.stringify(val) : String(val);
    if (typeof val === "string" && /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;   // stop spreadsheet formulas
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCSV(cols, rows) {
    return "﻿" + [cols.map(function (c) { return c[0]; }).join(",")].concat(rows.map(function (r) {
      return cols.map(function (c) { var x = typeof c[1] === "function" ? c[1](r) : r[c[1]]; if (c[2] === "$" && x != null && x !== "") x = dollars(x); return csvCell(x); }).join(",");
    })).join("\r\n") + "\r\n";
  }
  function download(name, text) {
    var url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    var a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }
  VIEWS.exports = function () {
    var from = store.get("adm.xFrom", ""), to = store.get("adm.xTo", "");
    main.innerHTML = '<div class="view"><h1>Exports</h1><p>CSV files for finance reconciliation. Amounts are in dollars. Every file carries the Stripe payment reference and GL code columns. Dates filter on when the order, ticket, comp or scan was created (Eastern).</p>' +
      '<div class="panel"><div class="btns">' + '<div class="field"><label for="xFrom">From</label><input type="date" id="xFrom" value="' + esc(from) + '"></div><div class="field"><label for="xTo">To</label><input type="date" id="xTo" value="' + esc(to) + '"></div></div>' +
      '<div class="btns" style="margin-top:14px">' + Object.keys(EXPORTS).map(function (k) { return '<button type="button" class="btn" data-export="' + k + '">Download ' + EXPORTS[k].label.toLowerCase() + " CSV</button>"; }).join("") + "</div>" +
      '<p id="xNote" role="status" class="hint" style="margin-top:10px"></p></div>' +
      '<div class="notice">Exports contain guest names and emails. Keep downloaded files in the finance shared folder only and delete local copies after reconciling.</div></div>';
    $$("[data-export]").forEach(function (b) {
      on(b, "click", function () {
        var kind = b.dataset.export, f = $("#xFrom").value, t = $("#xTo").value;
        store.set("adm.xFrom", f); store.set("adm.xTo", t);
        if (f && t && t < f) { $("#xNote").textContent = "The To date must be on or after the From date."; return; }
        $("#xNote").textContent = "Preparing " + EXPORTS[kind].label.toLowerCase() + "...";
        return rpc("tix", "admin_export", { p_app: APP, p_kind: kind, p_from: dayStart(f), p_to: dayAfter(t) }).then(function (rows) {
          rows = rows || [];
          download("concours-" + kind + "-" + (f || "start") + "-to-" + (t || todayStr()) + ".csv", toCSV(EXPORTS[kind].cols, rows));
          $("#xNote").textContent = EXPORTS[kind].label + ": " + rows.length + " row" + (rows.length === 1 ? "" : "s") + " downloaded.";
        });
      });
    });
  };

  // ===================================================================================== 8. Audit
  var AUDIT_KINDS = [["", "Everything"], ["comp", "Comps"], ["refund", "Refunds"], ["apply", "Tickets applied"], ["move", "Moves"], ["remove", "Removals"], ["unlock_phone", "Phone unlocks"], ["revoke", "Pass revocations"], ["catalog", "Catalogue and promo changes"], ["vehicle_token", "Vehicle tokens"]];
  VIEWS.audit = function () {
    main.innerHTML = '<div class="view"><div class="head"><h1>Audit log</h1><button type="button" class="btn ghost" id="auCsv">Download CSV</button></div>' +
      '<form id="auForm" class="btns">' + '<div class="field"><label for="auKind">Show</label><select id="auKind">' + AUDIT_KINDS.map(function (k) { return '<option value="' + k[0] + '">' + k[1] + "</option>"; }).join("") + "</select></div>" +
      '<div class="field" style="flex:1;min-width:220px"><label for="auQ">Filter</label><input type="search" id="auQ" placeholder="Person, guest, serial or reason"></div></form><div id="auList"><p class="muted">Loading...</p></div></div>';
    var rows = [];
    function norm(r) {   // admin_audit rows; comp_report rows as a fallback until BACKEND merges admin_audit
      return { at: r.at || r.created_at, kind: r.kind, by: r.by_email || r.by_user || "-", target: r.target || r.recipient || "-", reason: r.reason || "", serial: r.serial || "", amount_cents: r.amount_cents, details: r.details };
    }
    function paint() {
      var k = $("#auKind").value, q = $("#auQ").value.trim().toLowerCase();
      var list = rows.filter(function (r) { return (!k || r.kind === k || (k === "catalog" && /^(event|ticket_type|promo|pool)/.test(r.kind))) && (!q || [r.by, r.target, r.serial, r.reason].join(" ").toLowerCase().indexOf(q) >= 0); });
      $("#auList").innerHTML = '<p class="hint" role="status">' + list.length + " of " + rows.length + ' entries</p><div class="tablewrap"><table><thead><tr><th scope="col">When</th><th scope="col">What</th><th scope="col">Who</th><th scope="col">For</th><th scope="col">Why</th><th scope="col">Ticket or pass</th><th scope="col" class="num">Amount</th></tr></thead><tbody>' +
        (list.length ? list.map(function (r) { return "<tr><td>" + fmtDT(r.at) + "</td><td>" + pill(String(r.kind || "").replace(/_/g, " ")) + "</td><td>" + esc(r.by) + "</td><td>" + esc(r.target) + "</td><td>" + esc(r.reason) + '</td><td class="mono">' + esc(r.serial || "-") + '</td><td class="num">' + (r.amount_cents != null ? money(r.amount_cents) : "") + "</td></tr>"; }).join("") : emptyRow(7, "Nothing logged yet.")) +
        "</tbody></table></div>";
      return list;
    }
    $("#auKind").addEventListener("change", paint);
    $("#auQ").addEventListener("input", paint);
    $("#auForm").addEventListener("submit", function (e) { e.preventDefault(); });
    on("auCsv", "click", function () {
      download("concours-audit-" + todayStr() + ".csv", toCSV([["at", "at"], ["kind", "kind"], ["by", "by"], ["for", "target"], ["reason", "reason"], ["serial", "serial"], ["amount", "amount_cents", "$"], ["details", "details"]], paint()));
    });
    return rpc("tix", "admin_audit", { p_app: APP, p_limit: 1000 }).catch(function (e) {
      if (!/could not find the function|does not exist|PGRST202/i.test(e.message + " " + JSON.stringify(e.raw || {}))) throw e;
      return sel("tix", "comp_report", function (q) { return q.eq("app", APP).order("created_at", { ascending: false }).limit(1000); });
    }).then(function (r) { rows = (r || []).map(norm); paint(); }).catch(function (e) { $("#auList").innerHTML = errBlock(e); });
  };

  // ===================================================================================== 9. Curtis call additions (2026-10-22)
  /* Spec: audrain-apps/docs/2027-CURTIS-CALL-2026-10-22.md sections 1-4 and 6. Everything here calls RPCs from backend
     file 09, which may not be deployed yet. PostgREST answers PGRST202 (no such function), PGRST205 / 42P01 (no such
     table) or PGRST106 (schema not exposed); those turn into a plain "not switched on" notice instead of an error. */
  var NOT_ON = "Not switched on yet - needs the 09 back-end file.";
  function isMissing(e) {
    var raw = (e && e.raw) || {};
    return /^(PGRST202|PGRST205|PGRST106|42P01|42883|3F000)$/.test(String(raw.code || "")) || raw.status === 404 ||
      /could not find the (function|table)|does not exist|schema must be one of/i.test((e && e.message) || "");
  }
  function soft(e) { if (isMissing(e)) { var x = new Error(NOT_ON); x.notOn = true; x.raw = e.raw; throw x; } throw e; }
  function rpc9(schema, fn, args) { return rpc(schema, fn, args).catch(soft); }
  function sel9(schema, table, build) { return sel(schema, table, build).catch(soft); }
  function notOn(what) { return '<div class="notice" role="status">' + (what ? "<b>" + esc(what) + ":</b> " : "") + esc(NOT_ON) + "</div>"; }
  function fail9(el, what) { return function (e) { if (!e.notOn) console.warn(e); el.innerHTML = e.notOn ? notOn(what) : errBlock(e); }; }
  // Sponsors for pickers; null (not an error) while tix.sponsors does not exist.
  function loadSponsors() { return sel9("tix", "sponsors", function (q) { return q.eq("app", APP).order("name"); }).catch(function (e) { if (e.notOn) return null; throw e; }); }

  // The working year: after mid-October the next year's show is the one being sold.
  function defaultYear() { var d = new Date(); return d.getMonth() > 9 || (d.getMonth() === 9 && d.getDate() >= 15) ? d.getFullYear() + 1 : d.getFullYear(); }
  function curYear() { var y = Number(store.get("adm.year", 0)); return y >= 2025 && y <= 2100 ? y : defaultYear(); }
  function yearSelect(id, y) {
    var out = "", top = defaultYear() + 1;
    for (var x = top; x >= 2025; x--) out += '<option value="' + x + '"' + (x === y ? " selected" : "") + ">" + x + "</option>";
    return '<div class="field"><label for="' + id + '">Year</label><select id="' + id + '">' + out + "</select></div>";
  }
  function bindYear(id, reload) { $("#" + id).addEventListener("change", function () { store.set("adm.year", Number($("#" + id).value)); reload(); }); }
  // A calendar day ('YYYY-MM-DD', already an Eastern date from the server) shown without a time-zone shift.
  function fmtDay(s, o) { if (!s) return "-"; var p = String(s).slice(0, 10).split("-"); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2], 12)).toLocaleDateString("en-US", Object.assign({ timeZone: "UTC", month: "short", day: "numeric" }, o || {})); }
  function roasFmt(r) { return r == null || isNaN(r) ? "-" : Number(r).toFixed(2) + "x"; }
  // Bar for a returned fraction (sell-through, show rate); the number shown is the returned one.
  function fracMeter(f, label) {
    if (f == null || isNaN(f)) return '<span class="muted">-</span>';
    var p = Math.max(0, Math.min(100, Number(f) * 100));
    return '<div class="barrow"><div class="meter' + (f > 1 ? " over" : "") + '" role="img" aria-label="' + esc(label || "") + " " + pct(f) + '"><i style="width:' + p + '%"></i></div><span class="mono">' + pct(f) + "</span></div>";
  }
  function table(cols, rows, empty) {
    return '<div class="tablewrap"><table><thead><tr>' + cols.map(function (c) { return '<th scope="col"' + (c[2] ? ' class="num"' : "") + ">" + esc(c[0]) + "</th>"; }).join("") + "</tr></thead><tbody>" +
      (rows.length ? rows.map(function (r) { return "<tr>" + cols.map(function (c) { return "<td" + (c[2] ? ' class="num"' : "") + ">" + c[1](r) + "</td>"; }).join("") + "</tr>"; }).join("") : emptyRow(cols.length, empty)) + "</tbody></table></div>";
  }

  /* Inline SVG charts, no library. One y axis per chart (every series is dollars, or every series is tickets).
     spec: {rows, title, unit '$'|'n', label(row) -> x label, readout(row) -> text, empty,
            series:[{key, name, kind 'bar'|'line', cls 's1'|'s2', dash}]}.
     Hover, tap, or focus and the arrow keys move a highlight and the readout line; a table view sits under each chart. */
  var chartRO = window.ResizeObserver ? new ResizeObserver(function (es) { es.forEach(function (e) { var el = e.target; if (el._draw && el.isConnected && Math.abs(el.clientWidth - (el._w || 0)) > 8) el._draw(); }); }) : null;
  function niceMax(m) { if (!(m > 0)) return 1; var p = Math.pow(10, Math.floor(Math.log10(m))), f = m / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; }
  function compact(v, unit) {
    if (v == null) return "-";
    if (unit === "n") return Math.abs(v) >= 1e3 ? (v / 1e3).toFixed(v >= 1e4 ? 0 : 1) + "K" : String(Math.round(v));
    var d = Number(v) / 100, a = Math.abs(d);
    return a >= 1e6 ? "$" + (d / 1e6).toFixed(a >= 1e7 ? 0 : 1) + "M" : a >= 1e3 ? "$" + (d / 1e3).toFixed(a >= 1e4 ? 0 : 1) + "K" : "$" + d.toFixed(0);
  }
  function roundTop(x, y, w, h) { var r = Math.min(4, w / 2, h); return "M" + x + "," + (y + h) + "V" + (y + r) + "Q" + x + "," + y + " " + (x + r) + "," + y + "H" + (x + w - r) + "Q" + (x + w) + "," + y + " " + (x + w) + "," + (y + r) + "V" + (y + h) + "Z"; }
  function drawChart(el, spec) {
    var rows = spec.rows || [];
    if (!rows.length) { el._draw = null; el.innerHTML = '<p class="empty">' + esc(spec.empty || "No data yet.") + "</p>"; return; }
    el._draw = function () {
      var W = Math.max(280, el.clientWidth || 640), H = 240, L = 52, R = 14, T = 12, B = 28, pw = W - L - R, ph = H - T - B, n = rows.length, step = pw / n;
      el._w = el.clientWidth;
      var max = 0;
      rows.forEach(function (r) { spec.series.forEach(function (s) { if (r[s.key] != null && Number(r[s.key]) > max) max = Number(r[s.key]); }); });
      max = niceMax(max);
      var y = function (val) { return T + ph - ph * Number(val) / max; }, cx = function (i) { return L + step * (i + 0.5); };
      var g = "", t, every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(pw / 74))));
      for (t = 0; t <= 4; t++) { var ty = y(max * t / 4).toFixed(1); g += '<line class="gl' + (t ? "" : " base") + '" x1="' + L + '" x2="' + (W - R) + '" y1="' + ty + '" y2="' + ty + '"/><text class="tick" x="' + (L - 6) + '" y="' + (+ty + 4) + '" text-anchor="end">' + esc(compact(max * t / 4, spec.unit)) + "</text>"; }
      rows.forEach(function (r, i) { if ((n - 1 - i) % every === 0) g += '<text class="tick" x="' + cx(i).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(spec.label(r)) + "</text>"; });
      var bars = spec.series.filter(function (s) { return s.kind === "bar"; }), gap = 2;
      var bw = Math.max(1, Math.min(28, (step * 0.72 - gap * (bars.length - 1)) / Math.max(1, bars.length)));
      bars.forEach(function (s, j) {
        rows.forEach(function (r, i) {
          var val = Number(r[s.key]); if (r[s.key] == null || !(val > 0)) return;
          var x = cx(i) - (bw * bars.length + gap * (bars.length - 1)) / 2 + j * (bw + gap);
          g += '<path class="bar ' + s.cls + '" d="' + roundTop(+x.toFixed(1), +y(val).toFixed(1), +bw.toFixed(1), +(ph * val / max).toFixed(1)) + '"/>';
        });
      });
      spec.series.filter(function (s) { return s.kind === "line"; }).forEach(function (s) {
        var d = "", pen = false, dots = "";
        rows.forEach(function (r, i) {
          if (r[s.key] == null) { pen = false; return; }
          d += (pen ? "L" : "M") + cx(i).toFixed(1) + "," + y(r[s.key]).toFixed(1); pen = true;
          if (n <= 40) dots += '<circle class="dot ' + s.cls + '" cx="' + cx(i).toFixed(1) + '" cy="' + y(r[s.key]).toFixed(1) + '" r="4"/>';
        });
        g += '<path class="ln ' + s.cls + (s.dash ? " dash" : "") + '" d="' + d + '"/>' + dots;
      });
      el.innerHTML = (spec.series.length > 1 ? '<div class="legend" aria-hidden="true">' + spec.series.map(function (s) { return '<span><i class="sw ' + s.cls + (s.kind === "line" ? " ln" : "") + (s.dash ? " dash" : "") + '"></i>' + esc(s.name) + "</span>"; }).join("") + "</div>" : "") +
        '<p class="readout" aria-live="polite">' + esc(spec.hint || "Point at, tap or arrow through the chart to read each value.") + "</p>" +
        '<svg class="chart" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + " " + H + '" tabindex="0" role="img" aria-label="' + esc(spec.title + ". " + n + " points. Use the left and right arrow keys to read each one; the table below has every value.") + '">' +
        '<rect class="hl" x="0" y="' + T + '" width="' + step.toFixed(1) + '" height="' + ph + '" visibility="hidden"/><g aria-hidden="true">' + g + "</g></svg>";
      var svg = $("svg", el), hl = $(".hl", el), out = $(".readout", el), cur = -1;
      function set(i) { cur = Math.max(0, Math.min(n - 1, i)); hl.setAttribute("x", (L + step * cur).toFixed(1)); hl.setAttribute("visibility", "visible"); out.textContent = spec.readout(rows[cur]); }
      function at(e) { var b = svg.getBoundingClientRect(), i = Math.floor((e.clientX - b.left - L) / step); if (i >= 0 && i < n) set(i); }
      svg.addEventListener("pointermove", at);
      svg.addEventListener("pointerdown", at);
      svg.addEventListener("pointerleave", function (e) { if (e.pointerType === "mouse" && document.activeElement !== svg) hl.setAttribute("visibility", "hidden"); });
      svg.addEventListener("focus", function () { set(cur < 0 ? n - 1 : cur); });
      svg.addEventListener("blur", function () { hl.setAttribute("visibility", "hidden"); });
      svg.addEventListener("keydown", function (e) {
        var k = { ArrowLeft: -1, ArrowRight: 1, ArrowDown: -1, ArrowUp: 1 }[e.key];
        if (k) { e.preventDefault(); set(cur + k); } else if (e.key === "Home") { e.preventDefault(); set(0); } else if (e.key === "End") { e.preventDefault(); set(n - 1); }
      });
    };
    el._draw();
    if (chartRO) chartRO.observe(el);
  }
  function tableView(label, html) { return '<details class="tview"><summary>' + esc(label) + "</summary>" + html + "</details>"; }

  // ===================================================================================== 10. Dashboard (analytics.admin_dashboard)
  /* The season view for Michael and Curtis. Every number is shown exactly as the RPC returns it; the page only formats
     cents as dollars and works out a row's share of a total the RPC returned. */
  VIEWS.dashboard = function () {
    var year = curYear();
    main.innerHTML = '<div class="view"><div class="head"><div><h1>Dashboard</h1><div class="muted" id="dbAsOf"></div></div><div class="btns">' + yearSelect("dbYear", year) +
      '<button type="button" class="btn ghost" id="dbRefresh" style="align-self:flex-end">Refresh</button></div></div><div id="dbBody"><p class="muted" role="status">Loading...</p></div></div>';
    function load() {
      return rpc9("analytics", "admin_dashboard", { p_app: APP, p_year: Number($("#dbYear").value) }).then(renderDashboard).catch(fail9($("#dbBody"), "Dashboard"));
    }
    bindYear("dbYear", load);
    on("dbRefresh", "click", load);
    return load();
  };
  function renderDashboard(d) {
    d = d || {};
    var k = d.kpis || {}, daily = d.daily || [], weekly = d.weekly || [], yoy = (d.yoy || []).slice().sort(function (a, b) { return b.days_out - a.days_out; });
    var noSales = !k.orders && !k.paid_tickets && !k.comp_tickets && !daily.some(function (r) { return r.gross_cents || r.paid_tickets; });
    $("#dbAsOf").textContent = (d.year ? d.year + " season" : "") + (d.as_of ? " - as of " + fmtDT(d.as_of) : "");
    var gross = k.gross_cents;
    $("#dbBody").innerHTML =
      (noSales ? '<div class="notice" role="status">No sales yet for ' + esc(d.year || "this year") + ". The tiles and charts fill in as orders come in.</div>" : "") +
      '<section aria-labelledby="hKpi" style="margin-top:' + (noSales ? "18px" : "0") + '"><h2 id="hKpi" class="sr">Key numbers</h2><div class="grid tiles">' +
      tile("Gross sales", money(k.gross_cents), "Paid orders before tax and fees") +
      tile("Of goal", k.pct_of_goal == null ? "-" : k.pct_of_goal + "%", d.goal_cents != null ? "Goal " + money(d.goal_cents) : "No goal set (Ad spend and goal)") +
      tile("Net sales", money(k.net_cents), money(k.refunded_cents) + " refunded") +
      tile("Paid tickets", k.paid_tickets == null ? "-" : n0(k.paid_tickets)) + tile("Comp tickets", k.comp_tickets == null ? "-" : n0(k.comp_tickets)) +
      tile("Comp face value", money(k.comp_face_value_cents), "Ticket price of comps issued") +
      tile("Orders", k.orders == null ? "-" : n0(k.orders), "Average " + money(k.aov_cents)) +
      tile("Ad spend", money(k.ad_spend_cents), "Logged under Ad spend and goal") +
      tile("ROAS", roasFmt(k.roas), k.roas == null ? "No ad spend logged" : "Gross sales per $1 of ad spend") + "</div></section>" +
      '<section class="panel" aria-labelledby="hSalesC"><div class="head"><h2 id="hSalesC">Sales and ad spend</h2><div class="segmented" role="group" aria-label="Period"><button type="button" id="dbDay" aria-pressed="true">Daily</button><button type="button" id="dbWeek" aria-pressed="false">Weekly</button></div></div>' +
      '<p class="hint">Gross sales and ad spend on the same dollar scale. Eastern days; weeks start Monday.</p><div id="dbSales" class="chartbox"></div><div id="dbSalesT"></div></section>' +
      '<section class="panel" aria-labelledby="hYoy"><div class="head"><h2 id="hYoy">This year vs last year</h2><div class="segmented" role="group" aria-label="Measure"><button type="button" id="dbYg" aria-pressed="true">Gross</button><button type="button" id="dbYt" aria-pressed="false">Tickets</button></div></div>' +
      '<p class="hint">Cumulative, lined up on days before the first event.</p><div id="dbYoyNote"></div><div id="dbYoy" class="chartbox"></div><div id="dbYoyT"></div></section>' +
      '<section class="panel" aria-labelledby="hByEv"><h2 id="hByEv">By event</h2>' + table([
        ["Event", function (r) { return esc(r.event); }], ["Starts", function (r) { return fmtDT(r.starts_at); }], ["Paid", function (r) { return n0(r.paid_tickets); }, 1], ["Comp", function (r) { return n0(r.comp_tickets); }, 1],
        ["Gross", function (r) { return money(r.gross_cents); }, 1], ["Capacity", function (r) { return r.capacity == null ? "No limit" : n0(r.capacity); }, 1], ["Sell-through", function (r) { return fracMeter(r.sell_through, r.event + " sell-through"); }]
      ], d.by_event || [], "No events with sales yet.") + "</section>" +
      '<div class="grid two"><section class="panel" aria-labelledby="hByCh"><h2 id="hByCh">By channel</h2>' + table([
        ["Channel", function (r) { return esc(r.channel || "-"); }], ["Orders", function (r) { return n0(r.orders); }, 1], ["Gross", function (r) { return money(r.gross_cents); }, 1],
        ["Share of gross", function (r) { return fracMeter(ratio(Number(r.gross_cents || 0), Number(gross || 0)), (r.channel || "") + " share"); }]
      ], d.by_channel || [], "No orders yet.") + "</section>" +
      '<section class="panel" aria-labelledby="hByCr"><h2 id="hByCr">By creative</h2><p class="hint">From the utm tags on each order, matched to logged ad spend.</p>' + table([
        ["Platform", function (r) { return esc(r.platform || "-"); }], ["Campaign", function (r) { return esc(r.campaign || "(none)"); }], ["Content", function (r) { return esc(r.content || "-"); }],
        ["Purchases", function (r) { return n0(r.purchases); }, 1], ["Gross", function (r) { return money(r.gross_cents); }, 1], ["Spend", function (r) { return money(r.spend_cents); }, 1], ["ROAS", function (r) { return roasFmt(r.roas); }, 1]
      ], d.by_creative || [], "No tagged orders or ad spend yet.") + "</section></div>";

    var period = "day";
    function sales() {
      var rows = period === "day" ? daily : weekly, lab = period === "day" ? function (r) { return fmtDay(r.day); } : function (r) { return fmtDay(r.week_start); };
      $("#dbDay").setAttribute("aria-pressed", period === "day"); $("#dbWeek").setAttribute("aria-pressed", period === "week");
      drawChart($("#dbSales"), { rows: rows, unit: "$", title: (period === "day" ? "Daily" : "Weekly") + " gross sales with ad spend", label: lab, empty: "No sales yet.",
        series: [{ key: "gross_cents", name: "Gross sales", kind: "bar", cls: "s1" }, { key: "ad_spend_cents", name: "Ad spend", kind: "line", cls: "s2" }],
        readout: function (r) { return (period === "day" ? fmtDay(r.day, { weekday: "short" }) : "Week of " + fmtDay(r.week_start)) + ": gross " + money(r.gross_cents) + " - " + n0(r.paid_tickets) + " paid, " + n0(r.comp_tickets) + " comp" + (r.orders != null ? " - " + n0(r.orders) + " orders" : "") + " - ad spend " + money(r.ad_spend_cents); } });
      $("#dbSalesT").innerHTML = rows.length ? tableView("Show as a table", table([[period === "day" ? "Day" : "Week of", function (r) { return esc(period === "day" ? r.day : r.week_start); }], ["Gross", function (r) { return money(r.gross_cents); }, 1],
        ["Paid", function (r) { return n0(r.paid_tickets); }, 1], ["Comp", function (r) { return n0(r.comp_tickets); }, 1], ["Ad spend", function (r) { return money(r.ad_spend_cents); }, 1]], rows, "")) : "";
    }
    var measure = "g";
    function yoyDraw() {
      var g = measure === "g", tk = g ? "this_year_gross_cents" : "this_year_tickets", lk = g ? "last_year_gross_cents" : "last_year_tickets";
      var noBase = yoy.length && yoy.every(function (r) { return r.last_year_gross_cents == null && r.last_year_tickets == null; });
      $("#dbYg").setAttribute("aria-pressed", g); $("#dbYt").setAttribute("aria-pressed", !g);
      $("#dbYoyNote").innerHTML = noBase ? '<div class="notice" role="status"><b>Baseline not loaded.</b> Last year\'s numbers are imported from a verified source (ACMW report or Showpass export), never typed in. Until then only this year shows.</div>' : "";
      drawChart($("#dbYoy"), { rows: yoy, unit: g ? "$" : "n", title: "Cumulative " + (g ? "gross sales" : "paid tickets") + ", this year vs last year, by days before the event", label: function (r) { return r.days_out + "d"; }, empty: "No sales yet to compare.",
        series: [{ key: tk, name: "This year", kind: "line", cls: "s1" }].concat(noBase ? [] : [{ key: lk, name: "Last year", kind: "line", cls: "s2", dash: true }]),
        readout: function (r) { var f = g ? money : function (x) { return x == null ? "-" : n0(x); }; return r.days_out + " days out: this year " + f(r[tk]) + " - last year " + (r[lk] == null ? "not loaded" : f(r[lk])); } });
      $("#dbYoyT").innerHTML = yoy.length ? tableView("Show as a table", table([["Days out", function (r) { return n0(r.days_out); }, 1], ["This year gross", function (r) { return money(r.this_year_gross_cents); }, 1],
        ["Last year gross", function (r) { return r.last_year_gross_cents == null ? "-" : money(r.last_year_gross_cents); }, 1], ["This year tickets", function (r) { return r.this_year_tickets == null ? "-" : n0(r.this_year_tickets); }, 1],
        ["Last year tickets", function (r) { return r.last_year_tickets == null ? "-" : n0(r.last_year_tickets); }, 1]], yoy, "")) : "";
    }
    $("#dbDay").addEventListener("click", function () { period = "day"; sales(); });
    $("#dbWeek").addEventListener("click", function () { period = "week"; sales(); });
    $("#dbYg").addEventListener("click", function () { measure = "g"; yoyDraw(); });
    $("#dbYt").addEventListener("click", function () { measure = "t"; yoyDraw(); });
    sales(); yoyDraw();
  }

  // ===================================================================================== 11. Badges and accounts
  /* Pre-loaded badges are printed passes: serial (the account number Curtis asks for on the phone) + an 8-character claim
     code. Codes are returned once, by admin_mint_badges, and only ever live in the print file. */
  VIEWS.badges = function () {
    return Promise.all([loadCatalog(), sel("tix", "comp_reasons", function (q) { return q.order("label"); }), sel("tix", "comp_pools", function (q) { return q.eq("app", APP).order("name"); }), loadSponsors()]).then(function (r) {
      var reasons = r[1] || [], pools = r[2] || [], sponsors = r[3], year = curYear();
      main.innerHTML = '<div class="view"><h1>Badges and accounts</h1>' +
        '<section class="panel" aria-labelledby="hFind"><h2 id="hFind">Find an account</h2><form id="bfForm" class="btns" role="search"><div class="field" style="flex:1;min-width:220px"><label for="bfQ">Account number, email or name</label>' +
        '<input type="search" id="bfQ" aria-describedby="bfQh" value="' + esc(store.get("adm.bfQ", "")) + '"><span class="hint" id="bfQh">The last 4 or more characters of the account number are enough.</span></div><button class="btn" type="submit" id="bfGo" style="align-self:flex-start;margin-top:22px">Find</button></form>' +
        '<div id="bfList" style="margin-top:10px"></div><div id="bfDetail" style="margin-top:14px"></div></section>' +
        '<section class="panel" aria-labelledby="hLoad"><h2 id="hLoad">Load tickets onto an account</h2><p class="hint">Issues comp tickets onto a badge or a person\'s pass. The pass re-signs, so the holder\'s QR refreshes.</p><form id="blForm" class="form" novalidate>' +
        fld("blSerial", "Account number", "text", "", { required: true, hint: "Full number or the last 4+ characters", attrs: ' autocomplete="off" spellcheck="false"' }) +
        fld("blType", "Ticket type", "select", "", { html: typeOptions("", "Choose a ticket type"), required: true }) +
        fld("blQty", "How many", "number", 1, { attrs: ' min="1" max="20" step="1"' }) +
        fld("blReason", "Reason", "select", "", { required: true, options: [["", "Choose a reason"]].concat(reasons.map(function (x) { return [x.code, x.label]; })) }) +
        fld("blPool", "Comp pool", "select", "", { options: [["", "No pool"]].concat(pools.map(function (p) { return [p.id, p.name + " (" + Math.max(0, (p.allotment || 0) - (p.used || 0)) + " left)"]; })) }) +
        (sponsors ? fld("blSponsor", "Sponsor", "select", "", { options: [["", "No sponsor"]].concat(sponsors.map(function (s) { return [s.id, s.name]; })), hint: "Filled from the pool when it has one" }) : "") +
        fld("blHolder", "Holder name", "text", "", { hint: "Optional: the name to print on the tickets" }) +
        fld("blNote", "Note", "textarea", "", { wide: true, hint: "Who asked for it and why" }) +
        '<p class="err wide" id="blErr" role="alert"></p><div class="btns wide"><button type="submit" class="btn" id="blGo">Load tickets</button></div></form></section>' +
        '<section class="panel" aria-labelledby="hMint"><h2 id="hMint">Mint a batch of badges</h2><div class="notice warn" style="margin-bottom:12px"><b>The claim codes are shown once.</b> Minting downloads the print file (serial, code, qr, entry) straight away; print the <b>qr</b> column as the badge QR. It is the only copy: the codes cannot be looked up again. Save it to the print shared folder.</div>' +
        '<form id="bmForm" class="form" novalidate>' + fld("bmCount", "How many badges", "number", "", { required: true, attrs: ' min="1" max="2000" step="1"', hint: "Up to 2,000 per batch" }) +
        fld("bmBatch", "Batch name", "text", "", { required: true, hint: "e.g. sponsors-wave-1", attrs: ' maxlength="60"' }) + fld("bmYear", "Year", "number", year, { attrs: ' min="2025" max="2100" step="1"' }) +
        fld("bmNote", "Note", "textarea", "", { wide: true }) + '<p class="err wide" id="bmErr" role="alert"></p><div class="btns wide"><button type="submit" class="btn" id="bmGo">Mint and download print file</button></div></form></section></div>';
      function setPool() { var p = pools.find(function (x) { return x.id === $("#blPool").value; }); if (!p) return; if (p.ticket_type_id) $("#blType").value = p.ticket_type_id; if (sponsors && p.sponsor_id) $("#blSponsor").value = p.sponsor_id; }
      $("#blPool").addEventListener("change", setPool);
      $("#bfForm").addEventListener("submit", busy($("#bfGo"), findPasses));
      $("#blForm").addEventListener("submit", busy($("#blGo"), function () { return loadTickets(reasons, pools, sponsors); }));
      $("#bmForm").addEventListener("submit", busy($("#bmGo"), mintBadges));
      if (state.pass) return openPass(state.pass);
      if ($("#bfQ").value.trim().length >= 3) return findPasses();
    });
  };
  function findPasses() {
    var q = $("#bfQ").value.trim(); store.set("adm.bfQ", q);
    if (q.length < 3) { $("#bfList").innerHTML = '<p class="err" role="alert">Enter at least 3 characters.</p>'; return; }
    $("#bfDetail").innerHTML = "";
    return rpc9("tix", "admin_find_pass", { p_app: APP, p_q: q }).then(function (rows) {
      rows = rows || [];
      $("#bfList").innerHTML = '<p class="hint" role="status">' + rows.length + (rows.length >= 50 ? "+ matches (first 50). Type more of the number." : " match" + (rows.length === 1 ? "" : "es") + ".") + "</p>" + table([
        ["Account number", function (p) { return '<span class="mono">' + esc(p.serial) + "</span>"; }], ["Status", function (p) { return statusPill(p.status); }], ["Kind", function (p) { return esc(p.kind || "-"); }],
        ["Holder", function (p) { return esc(p.holder_name || "-") + '<div class="muted">' + esc(p.email || "") + "</div>"; }], ["Tickets", function (p) { return n0(p.ticket_count); }, 1],
        ["Batch", function (p) { return esc(p.batch || "-"); }], ["Claimed", function (p) { return p.claimed_at ? fmtDT(p.claimed_at) : '<span class="muted">-</span>'; }],
        ["", function (p) { return '<button type="button" class="btn ghost sm" data-pass="' + esc(p.serial) + '">Open</button>'; }]
      ], rows, "No account matches.");
      $$("[data-pass]").forEach(function (b) { on(b, "click", function () { return openPass(b.dataset.pass); }); });
      if (rows.length === 1) return openPass(rows[0].serial);
    }).catch(fail9($("#bfList"), "Find an account"));
  }
  /* Pass detail. tix.admin_pass_detail is an additive ask (Contract changes 2026-10-22 ADMIN); until it exists the
     tickets are gathered from the orders that carry the serial (admin_orders matches pass serials). */
  function passDetail(serial) {
    return rpc9("tix", "admin_pass_detail", { p_app: APP, p_serial: serial }).catch(function (e) {
      if (!e.notOn) throw e;
      return Promise.all([rpc9("tix", "admin_find_pass", { p_app: APP, p_q: serial }), rpc("tix", "admin_orders", { p_app: APP, p_q: serial, p_limit: 20 })]).then(function (r) {
        var pass = (r[0] || []).find(function (p) { return p.serial === serial; }) || { serial: serial };
        return Promise.all((r[1] || []).map(function (o) { return rpc("tix", "admin_order_detail", { p_order_id: o.id }); })).then(function (ds) {
          var tickets = [];
          ds.forEach(function (d) { ((d && d.tickets) || []).forEach(function (t) { if (t.pass_serial === serial) tickets.push(Object.assign({ order_id: d.order && d.order.id }, t)); }); });
          return { pass: pass, tickets: tickets, partial: true };
        });
      });
    });
  }
  function openPass(serial) {
    state.pass = serial;
    return passDetail(serial).then(function (d) {
      d = d || {}; var p = d.pass || { serial: serial }, tickets = d.tickets || [];
      $("#bfDetail").innerHTML = '<section class="panel inset" aria-labelledby="hPass"><div class="head"><div><h3 id="hPass">Account <span class="mono">' + esc(p.serial) + "</span></h3>" +
        '<div class="muted">' + esc(p.holder_name || "No holder yet") + (p.email ? " - " + esc(p.email) : "") + " - " + esc(p.kind || "attendee") + (p.batch ? " - batch " + esc(p.batch) : "") + (p.claimed_at ? " - claimed " + fmtDT(p.claimed_at) : p.status === "stock" ? " - not claimed" : "") + "</div></div>" +
        '<div class="btns">' + statusPill(p.status) + '<button type="button" class="btn sm" id="bpLoad">Load tickets onto this account</button>' +
        (p.printed_badge ? '<button type="button" class="btn danger sm" id="bpVoid">Void badge</button>' : "") + '<button type="button" class="btn ghost sm" id="bpClose">Close</button></div></div>' +
        (d.partial ? '<p class="hint">Tickets gathered from this account\'s orders (the full pass view needs admin_pass_detail).</p>' : "") +
        (p.badge_void_at ? '<p class="hint">Printed badge voided ' + fmtDT(p.badge_void_at) + ": its printed code no longer claims or scans.</p>" : "") +
        '<div style="margin-top:10px">' + table([
          ["Ticket", function (t) { return '<span class="mono">' + esc(t.serial) + "</span>"; }], ["Type", function (t) { return esc(t.type || t.type_name || typeLabel(t.ticket_type_id)); }],
          ["Holder", function (t) { return esc(t.holder_name || "-"); }], ["Status", function (t) { return statusPill(t.status) + (t.is_comp ? " " + pill(t.reason_code || "Comp") : ""); }],
          ["Scans", function (t) { var sc = t.scans || []; return sc.length ? sc.map(function (s) { return '<div class="hint">' + fmtDT(s.scanned_at) + " - " + esc(s.result) + "</div>"; }).join("") : '<span class="muted">' + (t.scans_valid ? n0(t.scans_valid) + " valid" : "None") + "</span>"; }],
          ["Actions", function (t) {
            var live = t.status !== "void" && t.status !== "refunded" && t.status !== "removed";
            return '<div class="btns">' + (live ? '<button type="button" class="btn ghost sm" data-mv="' + esc(t.id) + '">Move to another account</button>' : "") + (t.order_id ? '<button type="button" class="btn ghost sm" data-ord="' + esc(t.order_id) + '">Order</button>' : "") + "</div>";
          }]
        ], tickets, "No tickets on this account yet.") + "</div></section>";
      on("bpClose", "click", function () { state.pass = null; $("#bfDetail").innerHTML = ""; });
      on("bpLoad", "click", function () { $("#blSerial").value = p.serial; $("#blSerial").scrollIntoView({ block: "center" }); $("#blSerial").focus(); });
      on("bpVoid", "click", function () { return voidBadge(p, tickets); });
      $$("[data-mv]").forEach(function (b) { var t = tickets.find(function (x) { return x.id === b.dataset.mv; }); on(b, "click", function () { return moveTicketDialog(t, p.serial, function () { return refreshAccount(p.serial); }); }); });
      $$("[data-ord]").forEach(function (b) { b.addEventListener("click", function () { state.order = b.dataset.ord; go("orders"); }); });
      $("#bfDetail").scrollIntoView({ block: "nearest" });
    }).catch(function (e) { state.pass = null; fail9($("#bfDetail"), "Account detail")(e); });
  }
  /* A lost printed badge (tix.admin_void_badge): the printed code stops claiming and scanning for good. An unclaimed
     badge becomes void; a claimed one stays the holder's account and their phone pass re-signs. */
  function voidBadge(p, tickets) {
    var live = (tickets || []).filter(function (t) { return t.status === "issued" || t.status === "claimed"; }).length, stock = p.status === "stock";
    return confirmAction({ title: "Void printed badge " + p.serial + "?", danger: true, confirmLabel: "Void badge",
      message: "The printed code on badge <b class=\"mono\">" + esc(p.serial) + "</b> stops working for good: nobody can add it to an account or get in with it. This cannot be undone.<br>" +
        (stock ? "The badge is not claimed, so the whole badge becomes void." + (live ? " Its " + live + " live ticket" + (live === 1 ? " stays" : "s stay") + " on the void badge until you move " + (live === 1 ? "it" : "them") + " to another account." : "")
          : "The account stays active for " + esc(p.holder_name || p.email || "its holder") + "; their phone pass re-signs and keeps working.") }).then(function (why) {
      if (!why) return;
      return rpc9("tix", "admin_void_badge", { p_app: APP, p_serial: p.serial, p_reason: why }).then(function (r) {
        toast("Printed badge " + p.serial + " voided" + (r && r.tickets_left && r.status === "void" ? " - " + r.tickets_left + " ticket" + (r.tickets_left === 1 ? "" : "s") + " still on it" : ""));
        return refreshAccount(p.serial);
      });
    });
  }
  // After a change on an account: re-run the search above (its status and ticket counts change too), then show that account.
  function refreshAccount(serial) {
    var q = $("#bfQ") ? $("#bfQ").value.trim() : "";
    return Promise.resolve(q.length >= 3 ? findPasses() : null).then(function () { if (state.pass !== serial || !$("#hPass")) return openPass(serial); });
  }
  /* Turns what was typed (full serial or its last 4+ characters) into exactly one pass, or explains why not.
     Without admin_find_pass the typed value is passed through and the server decides. */
  function resolveSerial(typed) {
    var want = typed.trim().toUpperCase();
    return rpc9("tix", "admin_find_pass", { p_app: APP, p_q: typed.trim() }).catch(function (e) { if (e.notOn) return null; throw e; }).then(function (list) {
      if (!list) return { serial: typed.trim() };
      var exact = list.filter(function (p) { return String(p.serial).toUpperCase() === want; });
      var m = exact.length ? exact : list.filter(function (p) { var s = String(p.serial).toUpperCase(); return s.slice(-want.length) === want; });
      if (m.length === 1) return m[0];
      if (m.length) throw new Error("That matches " + m.length + " accounts (" + m.slice(0, 4).map(function (p) { return p.serial; }).join(", ") + (m.length > 4 ? ", ..." : "") + "). Enter more of the number.");
      throw new Error("No account number ends with " + typed.trim() + ".");
    });
  }
  function moveTicketDialog(t, fromSerial, after) {
    var r;
    return openDialog({
      title: "Move ticket " + t.serial + " to another account",
      body: '<div class="notice">The ticket leaves account <b class="mono">' + esc(fromSerial || "-") + "</b> and goes onto the account you enter. Both passes re-sign, so both QR codes refresh. No money moves.</div>" +
        fld("mvTo", "To account number", "text", "", { required: true, hint: "Full number or the last 4+ characters", attrs: ' autocomplete="off" spellcheck="false"' }) +
        fld("mvReason", "Reason (required, saved in the audit log)", "textarea", "", { required: true, attrs: ' minlength="3" maxlength="500"' }),
      buttons: [{ label: "Next", value: "ok" }, { label: "Cancel", value: "cancel", cls: "ghost" }],
      validate: function (b) { if (v(b, "mvTo").length < 4) return "Enter the account number (at least the last 4 characters)."; if (v(b, "mvReason").length < 3) return "Enter a reason (at least 3 characters)."; },
      collect: function (b) { return { to: v(b, "mvTo"), reason: v(b, "mvReason") }; }
    }).then(function (x) {
      if (!x) return; r = x;
      return resolveSerial(r.to).then(function (p) {
        if (fromSerial && p.serial === fromSerial) throw new Error("The ticket is already on account " + p.serial + ".");
        if (p.status === "void" || p.status === "refunded") throw new Error("Account " + p.serial + " is " + p.status + ". Pick an active account.");
        return confirmAction({ title: "Move to " + p.serial + "?", reason: false, confirmLabel: "Move ticket",
          message: "Ticket <b class=\"mono\">" + esc(t.serial) + "</b> (" + esc(t.type || t.type_name || typeLabel(t.ticket_type_id)) + ") moves from " + esc(fromSerial || "-") + " to <b class=\"mono\">" + esc(p.serial) + "</b>" +
            (p.holder_name || p.email ? " - " + esc(p.holder_name || "") + " " + esc(p.email || "") : "") + ".<br>Reason: " + esc(r.reason) }).then(function (ok) {
          if (!ok) return;
          return rpc9("tix", "admin_move_ticket", { p_ticket_id: t.id, p_to_serial: p.serial, p_reason: r.reason }).then(function () { toast("Ticket moved to " + p.serial); return after && after(); });
        });
      });
    });
  }
  function loadTickets(reasons, pools, sponsors) {
    var err = $("#blErr"); err.textContent = "";
    var serial = $("#blSerial").value.trim(), typeId = $("#blType").value, qty = Number($("#blQty").value), reason = $("#blReason").value, poolId = $("#blPool").value || null;
    var sponsorId = sponsors ? $("#blSponsor").value || null : null, holder = $("#blHolder").value.trim(), note = $("#blNote").value.trim();
    if (serial.length < 4) { err.textContent = "Enter the account number (at least the last 4 characters)."; return; }
    if (!typeId) { err.textContent = "Choose a ticket type."; return; }
    if (!Number.isInteger(qty) || qty < 1 || qty > 20) { err.textContent = "How many must be between 1 and 20."; return; }
    if (!reason) { err.textContent = "Choose a reason."; return; }
    var pool = pools.find(function (p) { return p.id === poolId; });
    if (pool && pool.ticket_type_id && pool.ticket_type_id !== typeId) { err.textContent = "That pool is for " + typeLabel(pool.ticket_type_id) + "."; return; }
    if (pool && qty > (pool.allotment || 0) - (pool.used || 0)) { err.textContent = "The pool has " + Math.max(0, (pool.allotment || 0) - (pool.used || 0)) + " left."; return; }
    if (pool && sponsorId && pool.sponsor_id && pool.sponsor_id !== sponsorId) { err.textContent = "That pool belongs to a different sponsor."; return; }
    if (holder.length > 120) { err.textContent = "The holder name is too long."; return; }
    return resolveSerial(serial).then(function (p) {
      if (p.status === "void" || p.status === "refunded") throw new Error("Account " + p.serial + " is " + p.status + ".");
      var rl = (reasons.find(function (x) { return x.code === reason; }) || {}).label || reason, sp = sponsors && sponsors.find(function (s) { return s.id === sponsorId; });
      return confirmAction({ title: "Load " + qty + " ticket" + (qty === 1 ? "" : "s") + " onto " + p.serial + "?", reason: false, confirmLabel: "Load tickets",
        message: "<b>" + qty + " x " + esc(typeLabel(typeId)) + "</b> at no charge onto account <b class=\"mono\">" + esc(p.serial) + "</b>" + (p.holder_name ? " (" + esc(p.holder_name) + ")" : p.status === "stock" ? " (unclaimed badge)" : "") +
          ".<br>Reason: <b>" + esc(rl) + "</b>" + (pool ? "<br>Pool: " + esc(pool.name) : "") + (sp ? "<br>Sponsor: " + esc(sp.name) : "") }).then(function (ok) {
        if (!ok) return;
        return rpc9("tix", "admin_load_pass", { p_app: APP, p_serial: p.serial, p_ticket_type_id: typeId, p_qty: qty, p_reason_code: reason, p_pool_id: poolId, p_sponsor_id: sponsorId, p_note: note || null, p_holder_name: holder || null })
          .then(function (res) {
            res = res || {};
            var n = res.issued_count != null ? res.issued_count : qty;
            toast(n + " ticket" + (n === 1 ? "" : "s") + " loaded onto " + (res.serial || p.serial) + (res.pool_remaining != null ? " - pool has " + res.pool_remaining + " left" : ""));
            $("#blHolder").value = ""; $("#blNote").value = "";
            return refreshAccount(res.serial || p.serial);
          });
      });
    });
  }
  function mintBadges() {
    var err = $("#bmErr"); err.textContent = "";
    var count = Number($("#bmCount").value), batch = $("#bmBatch").value.trim(), year = Number($("#bmYear").value), note = $("#bmNote").value.trim();
    if (!Number.isInteger(count) || count < 1 || count > 2000) { err.textContent = "How many badges must be a whole number from 1 to 2,000."; return; }
    if (!/^[A-Za-z0-9 ._-]{2,60}$/.test(batch)) { err.textContent = "Give the batch a name: 2 to 60 letters, numbers, spaces, dots, dashes or underscores."; return; }
    if (!Number.isInteger(year) || year < 2025 || year > 2100) { err.textContent = "Enter the year, e.g. " + defaultYear() + "."; return; }
    return confirmAction({ title: "Mint " + n0(count) + " badge" + (count === 1 ? "" : "s") + "?", reason: false, confirmLabel: "Mint and download",
      message: "Creates " + n0(count) + " unclaimed badge pass" + (count === 1 ? "" : "es") + " for " + year + " in batch <b>" + esc(batch) + "</b>.<br>The print file downloads straight away and is <b>the only copy of the claim codes</b>." }).then(function (ok) {
      if (!ok) return;
      var res;
      return rpc9("tix", "admin_mint_badges", { p_app: APP, p_year: year, p_count: count, p_batch: batch, p_note: note || null }).then(function (r) {
        res = r;
        return signBadges(((res && res.badges) || []).map(function (b) { return b.serial; }));
      }).then(function (signed) {
        var badges = (res && res.badges) || [], name = "concours-badges-" + year + "-" + batch.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" + todayStr() + ".csv";
        // qr = what goes in the ONE printed QR: the claim string, plus the signed entry after '|' when signing worked
        var rows = badges.map(function (b) { var en = signed.entries[b.serial] || ""; return { serial: b.serial, code: b.code, qr: en ? b.qr + "|" + en : b.qr, entry: en }; });
        var csv = toCSV([["serial", "serial"], ["code", "code"], ["qr", "qr"], ["entry", "entry"]], rows), minted = badges.length;
        var unsigned = rows.filter(function (x) { return !x.entry; }).length;
        badges = null; rows = null;
        download(name, csv);
        $("#bmCount").value = ""; $("#bmNote").value = "";
        return openDialog({
          title: "Print file downloaded",
          body: '<div class="notice warn" role="alert"><b>This is the only time these codes are available.</b> Check that <span class="mono">' + esc(name) + "</span> is in your downloads and move it to the print shared folder. Once you close this box the codes are gone from this page.</div>" +
            '<p>Batch <b>' + esc((res && res.batch) || batch) + "</b>: " + n0(minted) + " badge" + (minted === 1 ? "" : "s") + " in the file.</p>" +
            (unsigned ? '<div class="notice warn" role="status" id="bmUnsigned"><b>' + n0(unsigned) + " badge" + (unsigned === 1 ? "" : "s") + " scan online only.</b> " + esc(signed.note || "Those rows have no signed entry, so a gate phone without signal cannot check them.") + " The entry column is blank for " + (unsigned === 1 ? "it" : "them") + ".</div>"
              : '<p class="hint" id="bmSigned">Every badge carries a signed entry, so gate phones can check them with no signal.</p>') +
            '<div class="btns"><button type="button" class="btn" id="bmAgain">Download again</button></div>',
          buttons: [{ label: "I have the file", value: "cancel", cls: "ghost" }], focusButton: true,
          onOpen: function (b) { $("#bmAgain", b).addEventListener("click", function () { download(name, csv); }); }
        }).then(function () { csv = null; $("#dlgBody").innerHTML = ""; });
      });
    });
  }

  /* Signed entry strings for printed badges (2026-10-22 OFFLINE BADGES): POST credential/badges (admin JWT) ->
     {badges:[{serial, entry}], skipped}. Never fails the mint: on any error the print file still downloads, with the
     entry column blank and a note that those badges scan online only. */
  function signBadges(serials) {
    var out = { entries: {}, note: "" };
    if (!serials.length) return Promise.resolve(out);
    return SB.ready.then(function () {
      if (!SB.ok) throw new Error("No connection to the server right now");
      return SB.client.functions.invoke("credential/badges", { body: { serials: serials, app: APP } });
    }).then(function (r) {
      if (!r.error) return r.data;
      var ctx = r.error.context;
      var read = ctx && typeof ctx.json === "function" ? ctx.json().catch(function () { return null; }) : Promise.resolve(null);
      return read.then(function (j) {
        if (j && j.error === "not_configured") throw new Error("The badge signing key is not set up yet (credential function: " + (j.missing || []).join(", ") + ").");
        throw new Error("Signing failed: " + ((j && (j.message || j.error)) || r.error.message || "the request failed") + ".");
      });
    }).then(function (data) {
      ((data && data.badges) || []).forEach(function (b) { if (b && b.serial && /^AUD1\./.test(b.entry || "")) out.entries[b.serial] = b.entry; });
      if (Object.keys(out.entries).length < serials.length) out.note = "The signing service skipped some badges.";
      return out;
    }).catch(function (e) { out.entries = {}; out.note = e && e.message || "Signing failed."; return out; });
  }

  // ===================================================================================== 12. Sponsors and comp report
  VIEWS.sponsors = function () {
    var year = curYear();
    main.innerHTML = '<div class="view"><div class="head"><h1>Sponsors</h1><div class="btns">' + yearSelect("spYear", year) + '<button type="button" class="btn" id="spNew" style="align-self:flex-end">New sponsor</button></div></div>' +
      '<section class="panel" aria-labelledby="hSpList"><h2 id="hSpList">Sponsors</h2><p class="hint">Link a sponsor to a comp pool (Comps page) so its comps count as the sponsor\'s package.</p><div id="spList"><p class="muted">Loading...</p></div></section>' +
      '<section class="panel" aria-labelledby="hSpRep"><h2 id="hSpRep">Comp report</h2><p class="hint">Sponsor package = a comp from a sponsor\'s pool or with the sponsor reason; everything else is a straight comp. Attended = scanned in at least once.</p><div id="spReport"><p class="muted">Loading...</p></div></section></div>';
    var list = [];
    function load() {
      var y = Number($("#spYear").value);
      return Promise.all([
        sel9("tix", "sponsors", function (q) { return q.eq("app", APP).eq("year", y).order("name"); }).then(function (rows) {
          list = rows || []; renderSponsors(list, y);
          $$("[data-sp]").forEach(function (b) { on(b, "click", function () { return editSponsor(list.find(function (s) { return s.id === b.dataset.sp; }), y, list).then(function (saved) { if (saved) return load(); }); }); });
        }).catch(fail9($("#spList"), "Sponsors")),
        rpc9("tix", "admin_comp_report", { p_app: APP, p_year: y }).then(renderCompReport9).catch(fail9($("#spReport"), "Comp report"))
      ]);
    }
    bindYear("spYear", load);
    on("spNew", "click", function () { return editSponsor(null, Number($("#spYear").value), list).then(function (saved) { if (saved) return load(); }); });
    return load();
  };
  function renderSponsors(rows, year) {
    $("#spList").innerHTML = table([
      ["Sponsor", function (s) { return esc(s.name); }], ["Tier", function (s) { return esc(s.tier || "-"); }], ["Package", function (s) { return money(s.package_cents); }, 1],
      ["Contact", function (s) { return esc(s.contact_name || "-") + (s.contact_email ? '<div class="muted">' + esc(s.contact_email) + "</div>" : ""); }], ["Notes", function (s) { return esc(s.notes || ""); }],
      ["", function (s) { return '<button type="button" class="btn ghost sm" data-sp="' + esc(s.id) + '">Edit</button>'; }]
    ], rows, "No sponsors for " + year + " yet. Use New sponsor to add one.");
  }
  function editSponsor(s, year, list) {
    var d = s || { year: year }, tiers = [];
    list.forEach(function (x) { if (x.tier && tiers.indexOf(x.tier) < 0) tiers.push(x.tier); });
    return openDialog({
      title: s ? "Edit sponsor " + s.name : "New sponsor",
      body: '<div class="form">' + fld("f_name", "Sponsor name", "text", d.name, { required: true, wide: true }) +
        fld("f_tier", "Tier", "text", d.tier, { attrs: ' list="f_tiers"', hint: "e.g. Presenting, Gold, Partner" }) + '<datalist id="f_tiers">' + tiers.map(function (t) { return '<option value="' + esc(t) + '">'; }).join("") + "</datalist>" +
        fld("f_pkg", "Package value (dollars)", "text", d.package_cents == null ? "" : dollars(d.package_cents), { attrs: ' inputmode="decimal"', hint: "What the sponsorship is worth; blank if not set" }) +
        fld("f_year", "Year", "number", d.year || year, { attrs: ' min="2025" max="2100" step="1"' }) +
        fld("f_cname", "Contact name", "text", d.contact_name) + fld("f_cemail", "Contact email", "email", d.contact_email) +
        fld("f_notes", "Notes", "textarea", d.notes, { wide: true }) + "</div>",
      buttons: [{ label: "Save sponsor", value: "save" }, { label: "Cancel", value: "cancel", cls: "ghost" }],
      validate: function (b) {
        if (!v(b, "f_name")) return "Enter the sponsor name.";
        var p = v(b, "f_pkg"); if (p && (isNaN(toCents(p)) || toCents(p) < 0)) return "Enter the package value in dollars, or leave it blank.";
        if (!isInt(v(b, "f_year"), 2025, 2100) || !v(b, "f_year")) return "Enter the year.";
        if (v(b, "f_cemail") && !EMAIL_RE.test(v(b, "f_cemail"))) return "Enter a valid contact email, or leave it blank.";
      },
      collect: function (b) {
        var o = { name: v(b, "f_name"), tier: v(b, "f_tier") || null, package_cents: v(b, "f_pkg") ? toCents(v(b, "f_pkg")) : null, year: Number(v(b, "f_year")),
          contact_name: v(b, "f_cname") || null, contact_email: (v(b, "f_cemail") || "").toLowerCase() || null, notes: v(b, "f_notes") || null };
        if (s) o.id = s.id; return o;
      }
    }).then(function (o) {
      if (!o) return false;
      // A changed package value is money on the books, so it asks for a reason like the other money edits.
      var step = s && (o.package_cents || null) !== (s.package_cents == null ? null : s.package_cents)
        ? confirmAction({ title: "Change the package value?", confirmLabel: "Save change", message: esc(s.name) + ": " + money(s.package_cents) + " to <b>" + money(o.package_cents) + "</b>." }) : Promise.resolve("");
      return step.then(function (reason) {
        if (reason === null) return false;
        if (reason) o._reason = reason;
        return rpc9("tix", "admin_upsert_sponsor", { p_app: APP, p_sponsor: o }).then(function () { toast("Sponsor saved"); return true; });
      });
    });
  }
  function renderCompReport9(r) {
    r = r || {}; var t = r.totals || {}, pk = t.package || {}, st = t.straight || {}, bp = ratio(Number(pk.issued || 0), Number(t.issued || 0));
    $("#spReport").innerHTML = '<div class="grid tiles">' + tile("Comps issued", n0(t.issued)) + tile("Claimed", n0(t.claimed), "On someone's pass") +
      tile("Attended", n0(t.attended), pct(ratio(Number(t.attended || 0), Number(t.issued || 0))) + " of issued") + tile("Face value", money(t.face_value_cents), "Ticket price of comps issued") + "</div>" +
      '<h3 style="margin:16px 0 8px">Sponsor package vs straight comps</h3>' +
      (t.issued ? '<div class="split" role="img" aria-label="' + esc("Sponsor package " + pct(bp) + " of comps issued, straight comps " + pct(ratio(Number(st.issued || 0), Number(t.issued || 0)))) + '"><i class="s1" style="flex-basis:' + (100 * (bp || 0)) + '%"></i><i class="s2" style="flex-basis:' + (100 * (ratio(Number(st.issued || 0), Number(t.issued || 0)) || 0)) + '%"></i></div>' : "") +
      '<div class="grid two" style="margin-top:10px">' +
      '<div class="tile"><div class="k"><i class="sw s1" aria-hidden="true"></i> Sponsor package</div><div class="v">' + n0(pk.issued) + '</div><div class="s">issued - ' + n0(pk.attended) + " attended (" + pct(ratio(Number(pk.attended || 0), Number(pk.issued || 0))) + ")</div></div>" +
      '<div class="tile"><div class="k"><i class="sw s2" aria-hidden="true"></i> Straight comps</div><div class="v">' + n0(st.issued) + '</div><div class="s">issued - ' + n0(st.attended) + " attended (" + pct(ratio(Number(st.attended || 0), Number(st.issued || 0))) + ")</div></div></div>" +
      '<h3 style="margin:16px 0 8px">By sponsor</h3>' + table([
        ["Sponsor", function (x) { return esc(x.sponsor || "-"); }], ["Tier", function (x) { return esc(x.tier || "-"); }], ["Package", function (x) { return money(x.package_cents); }, 1],
        ["Allotment", function (x) { return x.allotment == null ? "-" : n0(x.allotment); }, 1], ["Issued", function (x) { return n0(x.issued); }, 1], ["Claimed", function (x) { return n0(x.claimed); }, 1],
        ["Attended", function (x) { return n0(x.attended); }, 1], ["Show rate", function (x) { return fracMeter(x.show_rate, (x.sponsor || "") + " show rate"); }]
      ], r.by_sponsor || [], "No sponsor comps yet.") +
      '<h3 style="margin:16px 0 8px">By reason</h3>' + table([
        ["Reason", function (x) { return esc(x.label || x.reason_code); }], ["Class", function (x) { return pill(x["class"] === "package" ? "Sponsor package" : "Straight", x["class"] === "package" ? "ok" : ""); }],
        ["Issued", function (x) { return n0(x.issued); }, 1], ["Claimed", function (x) { return n0(x.claimed); }, 1], ["Attended", function (x) { return n0(x.attended); }, 1],
        ["Show rate", function (x) { return pct(ratio(Number(x.attended || 0), Number(x.issued || 0))); }, 1], ["Face value", function (x) { return money(x.face_value_cents); }, 1]
      ], r.by_reason || [], "No comps issued yet.");
  }

  // ===================================================================================== 13. Ad spend and goal
  var PLATFORMS = [["meta", "Meta"], ["google", "Google"], ["tiktok", "TikTok"], ["other", "Other"]];
  var PLATFORM_ALIAS = { meta: "meta", facebook: "meta", fb: "meta", instagram: "meta", ig: "meta", google: "google", "google ads": "google", adwords: "google", youtube: "google", tiktok: "tiktok", "tik tok": "tiktok", other: "other" };
  // Accepts 2026-10-03, 10/3/2026 or 10/3/26; returns YYYY-MM-DD or "" when it is not a real date.
  function isoDay(s) {
    s = String(s || "").trim(); var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s), y, mo, d;
    if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; } else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s))) { mo = +m[1]; d = +m[2]; y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; } else return "";
    var t = new Date(Date.UTC(y, mo - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? t.toISOString().slice(0, 10) : "";
  }
  VIEWS.adspend = function () {
    var year = curYear(), grid = [blankSpend(), blankSpend(), blankSpend()];
    main.innerHTML = '<div class="view"><h1>Ad spend and goal</h1>' +
      '<section class="panel" aria-labelledby="hGoal"><h2 id="hGoal">Gross sales goal</h2><form id="gForm" class="form" novalidate>' + yearSelect("gYear", year) +
      fld("gAmt", "Goal (dollars)", "text", "", { attrs: ' inputmode="decimal"', hint: "Gross ticket sales before tax and fees" }) + fld("gNote", "Note", "text", "", { hint: "e.g. agreed with Curtis 2026-10-22" }) +
      fld("gDate", "First event day", "date", "", { hint: "Only needed for a year sold outside this system (2026 on Showpass), so this year vs last year lines up. Blank keeps the saved date." }) +
      '<div class="btns" style="align-self:flex-end"><button type="submit" class="btn" id="gGo">Save goal</button></div><p class="err wide" id="gErr" role="alert"></p></form><div id="gNow" style="margin-top:10px"></div></section>' +
      '<section class="panel" aria-labelledby="hSpend"><h2 id="hSpend">Enter ad spend</h2><p class="hint">One row per day, platform, campaign and content (the utm_campaign and utm_content on the ads). Saving a row with the same day, platform, campaign and content replaces the figure saved before.</p>' +
      '<div class="tablewrap"><table><thead><tr><th scope="col">Day</th><th scope="col">Platform</th><th scope="col">Campaign</th><th scope="col">Content</th><th scope="col">Spend ($)</th><th scope="col">Check</th><th scope="col"><span class="sr">Actions</span></th></tr></thead><tbody id="asRows"></tbody></table></div>' +
      '<div class="btns" style="margin-top:8px"><button type="button" class="btn ghost sm" id="asAdd">Add row</button><button type="button" class="btn ghost sm" id="asClear">Clear rows</button></div>' +
      '<div class="form" style="margin-top:12px">' + fld("asPaste", "Or paste from a spreadsheet or CSV", "textarea", "", { wide: true, hint: "Columns: day, platform, campaign, content, spend (dollars). A header row is fine; tabs or commas." }) + '</div><div class="btns" style="margin-top:8px"><button type="button" class="btn ghost" id="asUse">Add pasted rows</button></div>' +
      '<p class="err" id="asErr" role="alert" style="margin-top:8px"></p><div class="btns" style="margin-top:8px"><button type="button" class="btn" id="asSave">Save ad spend</button></div></section>' +
      '<section class="panel" aria-labelledby="hSpRecent"><h2 id="hSpRecent">Recently saved</h2><div id="asRecent"><p class="muted">Loading...</p></div></section></div>';
    function readGrid() {
      grid = $$("#asRows tr").filter(function (tr) { return $("[data-k=day]", tr); }).map(function (tr) {
        var o = {}; ["day", "platform", "campaign", "content", "spend"].forEach(function (k) { o[k] = $("[data-k=" + k + "]", tr).value.trim(); }); return o;
      });
    }
    function paintGrid(checked) {
      $("#asRows").innerHTML = grid.map(function (r, i) {
        var lab = function (k, t) { return '<label class="sr" for="as_' + k + i + '">Row ' + (i + 1) + " " + t + "</label>"; };
        return "<tr" + (r.problem ? ' class="bad"' : "") + "><td>" + lab("d", "day") + '<input type="date" id="as_d' + i + '" data-k="day" value="' + esc(isoDay(r.day) || r.day) + '"></td>' +
          "<td>" + lab("p", "platform") + '<select id="as_p' + i + '" data-k="platform"><option value="">Choose</option>' + PLATFORMS.map(function (p) { return '<option value="' + p[0] + '"' + (p[0] === r.platform ? " selected" : "") + ">" + p[1] + "</option>"; }).join("") + "</select></td>" +
          "<td>" + lab("c", "campaign") + '<input type="text" id="as_c' + i + '" data-k="campaign" value="' + esc(r.campaign) + '" maxlength="200"></td>' +
          "<td>" + lab("o", "content") + '<input type="text" id="as_o' + i + '" data-k="content" value="' + esc(r.content) + '" maxlength="200"></td>' +
          "<td>" + lab("s", "spend in dollars") + '<input type="text" id="as_s' + i + '" data-k="spend" inputmode="decimal" value="' + esc(r.spend) + '" style="max-width:120px"></td>' +
          "<td>" + (r.problem ? pill(r.problem, "bad wrap") : checked && !isBlank(r) ? pill("OK", "ok") : "") + '</td><td><button type="button" class="btn ghost sm" data-rm="' + i + '" aria-label="Remove row ' + (i + 1) + '">Remove</button></td></tr>';
      }).join("") || '<tr><td colspan="7" class="empty">No rows. Add a row or paste some.</td></tr>';
    }
    function isBlank(r) { return !r.day && !r.platform && !r.campaign && !r.content && !r.spend; }
    function check() {
      var seen = {}, bad = 0;
      grid.forEach(function (r, i) {
        r.problem = "";
        if (isBlank(r)) return;
        var c = toCents(r.spend), key = [isoDay(r.day), r.platform, low(r.campaign), low(r.content)].join("|");
        if (!isoDay(r.day)) r.problem = "Day is not a date";
        else if (!r.platform) r.problem = r.badPlatform ? 'Unknown platform "' + r.badPlatform + '"' : "Choose a platform";
        else if (isNaN(c) || c < 0) r.problem = "Spend must be 0 or more";
        else if (c > 100000000) r.problem = "Spend looks too big";
        else if (seen[key] != null) r.problem = "Same as row " + (seen[key] + 1);
        if (r.problem) bad++; else seen[key] = i;
      });
      return bad;
    }
    function fromPaste(text) {
      var lines = String(text || "").replace(/^﻿/, "").split(/\r?\n/).filter(function (l) { return l.trim(); });
      var rows = /\t/.test(lines.join("\n")) ? lines.map(function (l) { return l.split("\t"); }) : parseCSV(lines.join("\n"));
      var cols = { day: 0, platform: 1, campaign: 2, content: 3, spend: 4 };
      if (rows.length && /^(day|date)$/i.test((rows[0][0] || "").trim()) || rows.length && rows[0].some(function (c) { return /^\s*spend\s*(\(.*\))?\s*$/i.test(c); })) {
        var alias = { day: "day", date: "day", platform: "platform", campaign: "campaign", utm_campaign: "campaign", content: "content", utm_content: "content", ad: "content", creative: "content", spend: "spend", amount: "spend", cost: "spend" };
        cols = {}; rows[0].forEach(function (h, i) { var k = alias[low(h).replace(/\s*\(.*\)$/, "").replace(/\s+/g, "_")]; if (k && cols[k] == null) cols[k] = i; });
        rows = rows.slice(1);
      }
      return rows.map(function (r) {
        var g = function (k) { return cols[k] == null ? "" : String(r[cols[k]] || "").trim(); };
        var pl = PLATFORM_ALIAS[low(g("platform"))] || "";
        return { day: isoDay(g("day")) || g("day"), platform: pl, campaign: g("campaign"), content: g("content"), spend: g("spend").replace(/[$,\s]/g, ""), badPlatform: pl ? "" : g("platform") };
      });
    }
    paintGrid();
    $("#asRows").addEventListener("click", function (e) { var b = e.target.closest("[data-rm]"); if (!b) return; readGrid(); grid.splice(Number(b.dataset.rm), 1); paintGrid(); });
    $("#asAdd").addEventListener("click", function () { readGrid(); grid.push(blankSpend()); paintGrid(); });
    $("#asClear").addEventListener("click", function () { grid = [blankSpend()]; paintGrid(); $("#asErr").textContent = ""; });
    $("#asUse").addEventListener("click", function () {
      readGrid();
      var add = fromPaste($("#asPaste").value);
      if (!add.length) { $("#asErr").textContent = "Nothing to add: paste rows of day, platform, campaign, content, spend."; return; }
      grid = grid.filter(function (r) { return !isBlank(r); }).concat(add);
      $("#asPaste").value = "";
      check(); paintGrid(true);
      $("#asErr").textContent = "";
      toast(add.length + " row" + (add.length === 1 ? "" : "s") + " added. Check them, then Save.");
    });
    on("asSave", "click", function () {
      readGrid(); $("#asErr").textContent = "";
      var bad = check(); paintGrid(true);
      var rows = grid.filter(function (r) { return !isBlank(r); });
      if (bad) { $("#asErr").textContent = bad + " row" + (bad === 1 ? " has a" : "s have") + " problem" + (bad === 1 ? "" : "s") + ". Fix or remove " + (bad === 1 ? "it" : "them") + ", then save."; return; }
      if (!rows.length) { $("#asErr").textContent = "Add at least one row."; return; }
      if (rows.length > 1000) { $("#asErr").textContent = "Save at most 1,000 rows at a time."; return; }
      var days = rows.map(function (r) { return isoDay(r.day); }).sort();
      return confirmAction({ title: "Save " + rows.length + " ad spend row" + (rows.length === 1 ? "" : "s") + "?", reason: false, confirmLabel: "Save ad spend",
        message: rows.length + " row" + (rows.length === 1 ? "" : "s") + " from " + fmtDay(days[0], { year: "numeric" }) + " to " + fmtDay(days[days.length - 1], { year: "numeric" }) + ". Rows matching one already saved (same day, platform, campaign and content) replace it." }).then(function (ok) {
        if (!ok) return;
        return rpc9("analytics", "admin_upsert_ad_spend", { p_app: APP, p_rows: rows.map(function (r) { return { day: isoDay(r.day), platform: r.platform, campaign: r.campaign || null, content: r.content || null, spend_cents: toCents(r.spend) }; }) })
          .then(function (res) { toast((res && res.upserted != null ? res.upserted : rows.length) + " row" + (rows.length === 1 ? "" : "s") + " saved"); grid = [blankSpend()]; paintGrid(); return loadRecent(); });
      });
    });
    function loadRecent() {
      return sel9("analytics", "ad_spend", function (q) { return q.eq("app", APP).order("day", { ascending: false }).limit(100); }).then(function (rows) {
        rows = rows || [];
        $("#asRecent").innerHTML = '<p class="hint">Latest 100 rows. Edit copies a row into the grid above.</p>' + table([
          ["Day", function (r) { return esc(r.day); }], ["Platform", function (r) { return esc(r.platform); }], ["Campaign", function (r) { return esc(r.campaign || "-"); }], ["Content", function (r) { return esc(r.content || "-"); }],
          ["Spend", function (r) { return money(r.spend_cents); }, 1], ["Source", function (r) { return esc(r.source || "manual"); }], ["", function (r, i) { return '<button type="button" class="btn ghost sm" data-ase="' + esc(r.id) + '">Edit</button>'; }]
        ], rows, "No ad spend saved yet.");
        $$("[data-ase]").forEach(function (b) { b.addEventListener("click", function () {
          var r = rows.find(function (x) { return String(x.id) === b.dataset.ase; }); readGrid();
          grid = grid.filter(function (x) { return !isBlank(x); }).concat([{ day: r.day, platform: r.platform, campaign: r.campaign || "", content: r.content || "", spend: dollars(r.spend_cents) }]); paintGrid(); $("#asRows").scrollIntoView({ block: "nearest" });
        }); });
      }).catch(fail9($("#asRecent"), "Ad spend"));
    }
    function loadGoal() {
      return sel9("analytics", "goals", function (q) { return q.eq("app", APP).order("year", { ascending: false }); }).then(function (rows) {
        rows = rows || [];
        var cur = rows.find(function (g) { return g.year === Number($("#gYear").value); });
        if (cur && !$("#gAmt").value) { $("#gAmt").value = dollars(cur.gross_goal_cents); $("#gNote").value = cur.note || ""; $("#gDate").value = cur.event_date || ""; }
        $("#gNow").innerHTML = table([["Year", function (g) { return esc(g.year); }], ["Goal", function (g) { return money(g.gross_goal_cents); }, 1], ["First event day", function (g) { return g.event_date ? esc(fmtDay(g.event_date, { year: "numeric" })) : "-"; }], ["Note", function (g) { return esc(g.note || ""); }]], rows, "No goal set yet.");
      }).catch(fail9($("#gNow"), "Goals"));
    }
    $("#gYear").addEventListener("change", function () { store.set("adm.year", Number($("#gYear").value)); $("#gAmt").value = ""; $("#gNote").value = ""; $("#gDate").value = ""; loadGoal(); });
    $("#gForm").addEventListener("submit", busy($("#gGo"), function () {
      var y = Number($("#gYear").value), c = toCents($("#gAmt").value), note = $("#gNote").value.trim(), ed = $("#gDate").value;
      $("#gErr").textContent = "";
      if (isNaN(c) || c <= 0) { $("#gErr").textContent = "Enter the goal in dollars, e.g. 1,000,000."; return; }
      return confirmAction({ title: "Set the " + y + " goal?", reason: false, confirmLabel: "Save goal", message: "The " + y + " gross sales goal becomes <b>" + money(c) + "</b>" + (ed ? ", first event day " + esc(fmtDay(ed, { year: "numeric" })) : "") + ". The Dashboard's % of goal uses it." }).then(function (ok) {
        if (!ok) return;
        var args = { p_app: APP, p_year: y, p_cents: c, p_note: note || null };
        if (ed) args.p_event_date = ed;   // left out when blank, so 09 keeps the stored date
        return rpc9("analytics", "admin_set_goal", args).then(function () { toast("Goal saved"); return loadGoal(); });
      });
    }));
    return Promise.all([loadGoal(), loadRecent()]);
  };
  function blankSpend() { return { day: "", platform: "", campaign: "", content: "", spend: "" }; }

  // ===================================================================================== 14. Entrants (replaces Paperform)
  var APP_STATUS = [["", "All statuses"], ["submitted", "Submitted"], ["accepted", "Accepted"], ["waitlist", "Waitlist"], ["declined", "Declined"], ["withdrawn", "Withdrawn"], ["draft", "Draft"]];
  // Placeholder categories until Katelyn sends the real Paperform questions (spec section 4).
  var APP_CATS = [["", "All categories"], ["concours", "Concours"], ["supercar", "Supercar"], ["gathering", "Gathering"], ["other", "Other"]];
  var PHOTO_BUCKET = "entrant-photos";
  /* admin_applications rows, read tolerantly: nested {profile, vehicle, photos} as pinned in Contract changes, or flat columns. */
  function appRow(a) {
    var p = a.profile || {}, vh = a.vehicle || {};
    return { id: a.id, status: a.status, category: a.category, submitted_at: a.submitted_at, decided_at: a.decided_at, decision_note: a.decision_note, class_assigned: a.class_assigned,
      name: p.name || a.name || "", email: p.email || a.email || "", profile: p, vehicle: vh, answers: a.answers || {}, waiver_name: a.waiver_name, waiver_signed_at: a.waiver_signed_at,
      car: [vh.year || a.vehicle_year, vh.make || a.make, vh.model || a.model].filter(Boolean).join(" ") || "-", photos: a.photos || vh.photos || [] };
  }
  VIEWS.entrants = function () {
    var year = curYear(), f = store.get("adm.enF", { status: "submitted", category: "", q: "" }), rows = [], shots = [];
    main.innerHTML = '<div class="view"><h1>Entrants</h1>' +
      '<form id="enForm" class="btns" role="search">' + yearSelect("enYear", year) +
      '<div class="field"><label for="enStatus">Status</label><select id="enStatus">' + APP_STATUS.map(function (s) { return '<option value="' + s[0] + '"' + (s[0] === f.status ? " selected" : "") + ">" + s[1] + "</option>"; }).join("") + "</select></div>" +
      '<div class="field"><label for="enCat">Category</label><select id="enCat">' + APP_CATS.map(function (s) { return '<option value="' + s[0] + '"' + (s[0] === f.category ? " selected" : "") + ">" + s[1] + "</option>"; }).join("") + "</select></div>" +
      '<div class="field" style="flex:1;min-width:200px"><label for="enQ">Search</label><input type="search" id="enQ" placeholder="Name, email, make or model" value="' + esc(f.q) + '"></div>' +
      '<button class="btn" type="submit" id="enGo" style="align-self:flex-end">Apply</button></form>' +
      '<section class="panel" aria-labelledby="hEnQ"><h2 id="hEnQ">Applications</h2><div id="enList"><p class="muted">Loading...</p></div></section>' +
      '<section class="panel" aria-labelledby="hEnS"><h2 id="hEnS">Stats</h2><p class="hint">For questions like "we got 120 applications for this kind of car - do we build an event?"</p><div id="enStats"><p class="muted">Loading...</p></div></section>' +
      '<section class="panel" aria-labelledby="hEnR"><h2 id="hEnR">Previous applicants</h2><p>Everyone who applied before, for the "applications are open" email.</p><div class="btns">' +
      '<div class="field"><label for="enFrom">Applied since</label><input type="number" id="enFrom" min="2020" max="2100" step="1" value="' + (year - 1) + '"></div><button type="button" class="btn" id="enCsv" style="align-self:flex-end">Download previous applicants CSV</button></div>' +
      '<p class="hint" id="enCsvNote" role="status"></p><div class="notice" style="margin-top:8px">The file has names and emails. Keep it in the marketing shared folder only and delete local copies after the send.</div></section></div>';
    function paint() {
      var c = $("#enCat").value, list = rows.filter(function (a) { return !c || a.category === c; });
      $("#enList").innerHTML = '<p class="hint" role="status">' + list.length + " application" + (list.length === 1 ? "" : "s") + (c ? " in " + esc(c) : "") + ".</p>" + table([
        ["Submitted", function (a) { return a.submitted_at ? fmtDT(a.submitted_at) : '<span class="muted">Not yet</span>'; }], ["Entrant", function (a) { return esc(a.name || "-") + '<div class="muted">' + esc(a.email) + "</div>"; }],
        ["Car", function (a) { return esc(a.car); }], ["Category", function (a) { return esc(a.category || "-"); }], ["Status", function (a) { return statusPill(a.status) + (a.class_assigned ? '<div class="hint">' + esc(a.class_assigned) + "</div>" : ""); }],
        ["Photos", function (a) { return n0(a.photos.length); }, 1], ["", function (a) { return '<button type="button" class="btn ghost sm" data-app="' + esc(a.id) + '">Open</button>'; }]
      ], list, "No applications match.");
      $$("[data-app]").forEach(function (b) { on(b, "click", function () { return openApplication(rows.find(function (a) { return a.id === b.dataset.app; }), shots, load); }); });
    }
    function load() {
      var y = Number($("#enYear").value); f = { status: $("#enStatus").value, category: $("#enCat").value, q: $("#enQ").value.trim() }; store.set("adm.enF", f);
      return Promise.all([
        rpc9("entrants", "admin_applications", { p_app: APP, p_year: y, p_status: f.status || null, p_q: f.q || null }).then(function (r) { rows = (r || []).map(appRow); paint(); }).catch(fail9($("#enList"), "Applications")),
        rpc9("entrants", "admin_stats", { p_app: APP, p_year: y }).then(renderEntrantStats).catch(fail9($("#enStats"), "Stats"))
      ]);
    }
    $("#enForm").addEventListener("submit", busy($("#enGo"), load));
    $("#enCat").addEventListener("change", paint);
    bindYear("enYear", load);
    on("enCsv", "click", function () {
      var y = Number($("#enFrom").value);
      if (!Number.isInteger(y) || y < 2020 || y > 2100) { $("#enCsvNote").textContent = "Enter a year, e.g. " + (curYear() - 1) + "."; return; }
      $("#enCsvNote").textContent = "Preparing...";
      return rpc9("entrants", "admin_reopen_list", { p_app: APP, p_from_year: y }).then(function (r) {
        r = r || [];
        download("concours-previous-applicants-since-" + y + "-" + todayStr() + ".csv", toCSV([["email", "email"], ["name", "name"], ["vehicles", function (x) { return carList(x.vehicles); }], ["last_status", "last_status"]], r));
        $("#enCsvNote").textContent = r.length + " applicant" + (r.length === 1 ? "" : "s") + " downloaded.";
      }).catch(function (e) { $("#enCsvNote").textContent = e.message; });
    });
    return Promise.all([sel("entrants", "shots", function (q) { return q.order("sort"); }).then(function (s) { shots = s || []; }).catch(function () { shots = []; }), load()]);
  };
  function carList(vs) {
    if (!vs) return "";
    if (!Array.isArray(vs)) return String(vs);
    return vs.map(function (x) { return typeof x === "string" ? x : [x.year, x.make, x.model].filter(Boolean).join(" "); }).join("; ");
  }
  // admin_stats buckets: [{key, count}] as pinned, or an object {key: count}; both are shown as returned.
  function statRows(x) {
    if (!x) return [];
    if (Array.isArray(x)) return x.map(function (r) { return { key: r.key != null ? r.key : (r.status || r.category || r.make || r.decade || r.label || "-"), count: Number(r.count != null ? r.count : r.n) }; });
    return Object.keys(x).map(function (k) { return { key: k, count: Number(x[k]) }; }).sort(function (a, b) { return b.count - a.count; });
  }
  function renderEntrantStats(s) {
    s = s || {};
    function box(title, rows) {
      var top = rows.reduce(function (a, r) { return Math.max(a, r.count || 0); }, 0);
      return '<div><h3 style="margin-bottom:6px">' + esc(title) + "</h3>" + table([["", function (r) { return esc(r.key == null || r.key === "" ? "-" : r.key); }], ["Applications", function (r) { return n0(r.count); }, 1],
        ["", function (r) { return '<div class="meter" aria-hidden="true"><i style="width:' + (top ? 100 * r.count / top : 0) + '%"></i></div>'; }]], rows.slice(0, 20), "None yet.") +
        (rows.length > 20 ? '<p class="hint">and ' + (rows.length - 20) + " more</p>" : "") + "</div>";
    }
    $("#enStats").innerHTML = '<div class="grid two">' + box("By status", statRows(s.by_status)) + box("By category", statRows(s.by_category)) + box("By make", statRows(s.by_make)) + box("By decade", statRows(s.by_decade)) + "</div>";
  }
  function signedUrls(paths) {
    if (!paths.length) return Promise.resolve({});
    return SB.ready.then(function () {
      if (!SB.ok) throw new Error("No connection to the server right now");
      return SB.client.storage.from(PHOTO_BUCKET).createSignedUrls(paths, 900);
    }).then(function (r) {
      if (r.error) throw r.error;
      var m = {}; (r.data || []).forEach(function (x) { if (x.signedUrl && !x.error) m[x.path] = x.signedUrl; }); return m;
    });
  }
  function openApplication(a, shots, reload) {
    var label = {}; shots.forEach(function (s) { label[s.code] = s.label; });
    var have = {}; a.photos.forEach(function (p) { have[p.shot] = true; });
    var missing = shots.filter(function (s) { return s.required && !have[s.code]; }).map(function (s) { return s.label; });
    var vh = a.vehicle, p = a.profile, ans = a.answers || {};
    function kv(pairs) { return '<dl class="kv">' + pairs.filter(function (x) { return x[1] != null && x[1] !== ""; }).map(function (x) { return "<dt>" + esc(x[0]) + "</dt><dd>" + esc(x[1]) + "</dd>"; }).join("") + "</dl>"; }
    var undecided = a.status === "submitted" || a.status === "waitlist";
    return openDialog({
      title: a.car + " - " + (a.name || a.email), wide: true,
      body: '<div class="btns">' + statusPill(a.status) + (a.category ? pill(a.category) : "") + (a.class_assigned ? pill("Class: " + a.class_assigned, "ok") : "") + "</div>" +
        (missing.length ? '<div class="notice warn">Missing required photos: ' + esc(missing.join(", ")) + "</div>" : "") +
        '<div class="grid two"><div><h3>Entrant</h3>' + kv([["Name", a.name], ["Email", a.email], ["Phone", p.phone], ["Location", [p.city, p.state, p.country].filter(Boolean).join(", ")], ["Instagram", p.instagram]]) + "</div>" +
        "<div><h3>Car</h3>" + kv([["Year", vh.year], ["Make", vh.make], ["Model", vh.model], ["Body", vh.body], ["Chassis no.", vh.chassis_no], ["Colour", vh.color], ["Engine", vh.engine], ["Notes", vh.notes]]) + "</div></div>" +
        "<h3>Photos</h3>" + (a.photos.length ? '<div class="photos" id="enPhotos">' + a.photos.map(function (ph, i) { return '<figure><div class="ph" data-i="' + i + '">Loading photo...</div><figcaption>' + esc(label[ph.shot] || ph.shot) + "</figcaption></figure>"; }).join("") + "</div>" : '<p class="muted">No photos uploaded.</p>') +
        "<h3>Answers</h3>" + (Object.keys(ans).length ? kv(Object.keys(ans).map(function (k) { var x = ans[k]; return [k.replace(/_/g, " "), typeof x === "object" ? JSON.stringify(x) : x]; })) : '<p class="muted">No answers.</p>') +
        kv([["Waiver signed by", a.waiver_name], ["Waiver signed", a.waiver_signed_at ? fmtDT(a.waiver_signed_at) : ""], ["Submitted", a.submitted_at ? fmtDT(a.submitted_at) : ""], ["Decided", a.decided_at ? fmtDT(a.decided_at) : ""], ["Decision note", a.decision_note]]),
      buttons: (a.status === "draft" || a.status === "withdrawn" ? [] : [{ label: "Accept", value: "accepted" }, { label: "Waitlist", value: "waitlist", cls: "ghost" }, { label: "Decline", value: "declined", cls: "danger" }]
        .concat(a.status === "submitted" ? [] : [{ label: "Undo decision", value: "submitted", cls: "ghost" }]))
        .filter(function (b) { return b.value !== a.status; }).concat([{ label: "Close", value: "cancel", cls: "ghost" }]),
      focusButton: true,
      onOpen: function (b) {
        if (!a.photos.length) return;
        signedUrls(a.photos.map(function (x) { return x.storage_path; })).then(function (m) {
          a.photos.forEach(function (ph, i) {
            var box = $('.ph[data-i="' + i + '"]', b); if (!box) return;
            var u = m[ph.storage_path];
            box.innerHTML = u ? '<a href="' + esc(u) + '" target="_blank" rel="noopener"><img src="' + esc(u) + '" alt="' + esc((label[ph.shot] || ph.shot) + " - " + a.car) + '" loading="lazy"></a>' : '<span class="muted">Photo not found</span>';
          });
        }).catch(function (e) { $$(".ph", b).forEach(function (x) { x.textContent = "Could not load photos: " + e.message; }); });
      }
    }).then(function (status) {
      if (!status || status === "cancel") return;
      return decideApplication(a, status, undecided).then(function (done) { if (done) return reload(); });
    });
  }
  function decideApplication(a, status, undecided) {
    var word = { accepted: "Accept", waitlist: "Waitlist", declined: "Decline", submitted: "Undo the decision on" }[status];
    return openDialog({
      title: word + " " + (a.name || a.email) + "'s " + a.car + "?",
      body: '<div class="notice' + (status === "declined" ? " warn" : "") + '">' + (undecided ? "" : "This changes a decision already made (" + esc(a.status) + "). ") + "The entrant sees the new status in the app.</div>" +
        (status === "accepted" || status === "waitlist" ? fld("dcClass", "Class", "text", a.class_assigned, { hint: "Optional, e.g. Pre-war American", attrs: ' maxlength="80"' }) : "") +
        fld("dcNote", "Note (required, saved with the decision)", "textarea", "", { required: true, attrs: ' minlength="3" maxlength="500"' }),
      buttons: [{ label: status === "submitted" ? "Undo decision" : word, value: "ok", cls: status === "declined" ? "danger" : "primary" }, { label: "Cancel", value: "cancel", cls: "ghost" }],
      validate: function (b) { if (v(b, "dcNote").length < 3) return "Enter a note (at least 3 characters)."; },
      collect: function (b) { return { cls: status === "accepted" || status === "waitlist" ? v(b, "dcClass") : null, note: v(b, "dcNote") }; }
    }).then(function (r) {
      if (!r) return false;
      return rpc9("entrants", "admin_decide", { p_id: a.id, p_status: status, p_class: r.cls || null, p_note: r.note }).then(function () { toast({ accepted: "Accepted", waitlist: "Moved to the waitlist", declined: "Declined", submitted: "Decision undone - back to submitted" }[status]); return true; });
    });
  }
})();
