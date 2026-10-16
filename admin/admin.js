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
  var state = { view: store.get("adm.view", "dashboard"), order: null, preview: null, timers: [] };
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
      partially_refunded: "warn", full: "bad", closed: "bad", refunded: "bad", void: "bad", cancelled: "bad", failed: "bad" }[s];
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

  // ===================================================================================== 1. Dashboard
  VIEWS.dashboard = function () {
    var from = store.get("adm.fFrom", ""), to = store.get("adm.fTo", "");
    main.innerHTML = '<div class="view">' +
      '<div class="head"><h1>Dashboard</h1><button type="button" class="btn ghost" id="dRefresh">Refresh</button></div>' +
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
  function checkRecipients(rows) {
    if (rows.length && /^e-?mail/i.test((rows[0][0] || "").trim())) rows = rows.slice(1);
    var seen = {};
    return rows.map(function (r, i) {
      var email = (r[0] || "").trim().toLowerCase(), name = (r[1] || "").trim(), problem = "";
      if (!email) problem = "Email is missing";
      else if (!EMAIL_RE.test(email)) problem = "Email is not valid";
      else if (seen[email]) problem = "Listed twice (row " + seen[email] + ")";
      else if (r.length > 2 && r.slice(2).some(function (x) { return x.trim(); })) problem = "Too many columns: use email,name";
      else if (name.length > 120) problem = "Name is too long";
      if (!problem) seen[email] = i + 1;
      return { row: i + 1, email: email, name: name, problem: problem };
    });
  }
  VIEWS.comps = function () {
    return Promise.all([loadCatalog(), sel("tix", "comp_reasons", function (q) { return q.order("label"); }), sel("tix", "comp_pools", function (q) { return q.eq("app", APP).order("name"); })])
      .then(function (r) {
        var reasons = r[1] || [], pools = r[2] || [];
        state.preview = null;
        main.innerHTML = '<div class="view"><h1>Comps</h1>' +
          '<section class="panel" aria-labelledby="hIssue"><h2 id="hIssue">Issue comps</h2><form id="cForm" class="form" novalidate>' +
          fld("cType", "Ticket type", "select", "", { html: typeOptions("", "Choose a ticket type"), required: true }) +
          fld("cQty", "Tickets per person", "number", 1, { attrs: ' min="1" max="10" step="1"' }) +
          fld("cReason", "Reason", "select", "", { required: true, options: [["", "Choose a reason"]].concat(reasons.map(function (x) { return [x.code, x.label]; })) }) +
          fld("cPool", "Comp pool", "select", "", { options: [["", "No pool"]].concat(pools.map(function (p) { return [p.id, p.name + " (" + Math.max(0, (p.allotment || 0) - (p.used || 0)) + " left)"]; })), hint: "Counts against the pool's allotment" }) +
          fld("cNote", "Note", "textarea", "", { wide: true, hint: "Who asked for it and why. Saved with each comp." }) +
          '<fieldset class="wide" style="border:0;padding:0;margin:0"><legend class="lbl">Recipients</legend><div class="segmented" role="group" aria-label="Recipients"><button type="button" id="cModeOne" aria-pressed="true">One person</button><button type="button" id="cModeList" aria-pressed="false">Upload a list</button></div></fieldset>' +
          '<div class="wide" id="cOne"><div class="form">' + fld("cEmail", "Email", "email", "") + fld("cName", "Name", "text", "") + "</div></div>" +
          '<div class="wide" id="cList" hidden><div class="form">' + fld("cFile", "CSV file", "file", "", { attrs: ' accept=".csv,text/csv"', hint: "One person per row: email,name. A header row is fine." }) +
          fld("cPaste", "Or paste rows", "textarea", "", { hint: "email,name on each line" }) + '</div><div class="btns" style="margin-top:8px"><button type="button" class="btn ghost" id="cPreviewBtn">Preview list</button></div><div id="cPreview" style="margin-top:10px"></div></div>' +
          '<p class="err wide" id="cErr" role="alert"></p><div class="btns wide"><button type="submit" class="btn" id="cIssue">Issue comps</button></div></form></section>' +
          '<section class="panel" aria-labelledby="hPools"><div class="head"><h2 id="hPools">Comp pools</h2><button type="button" class="btn ghost" id="pNew">New pool</button></div><div id="pTable" style="margin-top:10px"></div></section>' +
          '<section class="panel" aria-labelledby="hCompRep"><h2 id="hCompRep">Comp report</h2><div id="cReport"><p class="muted">Loading...</p></div></section></div>';
        renderPools(pools);
        var mode = "one";
        function setMode(m) { mode = m; $("#cModeOne").setAttribute("aria-pressed", m === "one"); $("#cModeList").setAttribute("aria-pressed", m === "list"); $("#cOne").hidden = m !== "one"; $("#cList").hidden = m !== "list"; }
        $("#cModeOne").addEventListener("click", function () { setMode("one"); });
        $("#cModeList").addEventListener("click", function () { setMode("list"); });
        $("#cPool").addEventListener("change", function () { var p = pools.find(function (x) { return x.id === $("#cPool").value; }); if (p && p.ticket_type_id) $("#cType").value = p.ticket_type_id; });
        function preview(text) { state.preview = checkRecipients(parseCSV(text)); renderPreview(); }
        $("#cFile").addEventListener("change", function () {
          var f = $("#cFile").files[0]; if (!f) return;
          if (f.size > 512 * 1024) { $("#cPreview").innerHTML = errBlock("That file is too big. Keep lists under 500 people."); return; }
          f.text().then(preview);
        });
        $("#cPreviewBtn").addEventListener("click", function () { preview($("#cPaste").value); });
        $("#cForm").addEventListener("submit", busy($("#cIssue"), function () {
          $("#cErr").textContent = "";
          var typeId = $("#cType").value, qty = Number($("#cQty").value), reason = $("#cReason").value, poolId = $("#cPool").value || null, note = $("#cNote").value.trim();
          var recipients, skipped = 0;
          if (!typeId) return fail("Choose a ticket type.");
          if (!Number.isInteger(qty) || qty < 1 || qty > 10) return fail("Tickets per person must be between 1 and 10.");
          if (!reason) return fail("Choose a reason.");
          if (mode === "one") {
            var em = $("#cEmail").value.trim().toLowerCase();
            if (!EMAIL_RE.test(em)) return fail("Enter a valid email for the recipient.");
            recipients = [{ email: em, name: $("#cName").value.trim() || null }];
          } else {
            if (!state.preview) return fail("Upload a CSV file or paste rows, then preview the list.");
            recipients = state.preview.filter(function (x) { return !x.problem; }).map(function (x) { return { email: x.email, name: x.name || null }; });
            skipped = state.preview.length - recipients.length;
            if (!recipients.length) return fail("No valid rows to issue.");
            if (recipients.length > 500) return fail("Issue at most 500 people at a time.");
          }
          var total = recipients.length * qty, pool = pools.find(function (p) { return p.id === poolId; });
          if (pool) {
            var left = (pool.allotment || 0) - (pool.used || 0);
            if (pool.ticket_type_id && pool.ticket_type_id !== typeId) return fail("That pool is for " + typeLabel(pool.ticket_type_id) + ". Pick that ticket type or a different pool.");
            if (total > left) return fail("The pool has " + left + " left; this would issue " + total + ".");
          }
          var reasonLabel = (reasons.find(function (x) { return x.code === reason; }) || {}).label || reason;
          return confirmAction({
            title: "Issue " + total + " comp ticket" + (total === 1 ? "" : "s") + "?", confirmLabel: "Issue comps", reason: false,
            message: "<b>" + recipients.length + "</b> " + (recipients.length === 1 ? "person" : "people") + " get " + qty + " x " + esc(typeLabel(typeId)) + " at no charge.<br>Reason: <b>" + esc(reasonLabel) + "</b>" +
              (pool ? "<br>Pool: " + esc(pool.name) : "") + (skipped ? '<br><span class="err">' + skipped + " row" + (skipped === 1 ? "" : "s") + " with problems will be skipped.</span>" : "")
          }).then(function (ok) {
            if (!ok) return;
            return rpc("tix", "issue_comp2", { p_app: APP, p_ticket_type_id: typeId, p_qty: qty, p_reason_code: reason, p_note: note || null, p_pool_id: poolId, p_recipients: recipients })
              .then(function (res) {
                var n = res && (res.issued_count || (res.tickets && res.tickets.length)) || total;
                toast(n + " comp ticket" + (n === 1 ? "" : "s") + " issued");
                return openDialog({ title: "Comps issued", body: '<p>' + n + " ticket" + (n === 1 ? "" : "s") + " issued for " + recipients.length + " " + (recipients.length === 1 ? "person" : "people") + ". Each person gets the ticket on their pass when they sign in with that email.</p>" + (skipped ? '<p class="muted">' + skipped + " row(s) were skipped. Fix them and upload those rows again.</p>" : ""), buttons: [{ label: "Done", value: "cancel", cls: "primary" }] })
                  .then(function () { return VIEWS.comps(); });
              });
          });
          function fail(m) { $("#cErr").textContent = m; }
        }));
        on("pNew", "click", function () { return editPool(null); });
        $$("[data-pool-edit]", main).forEach(function (b) { on(b, "click", function () { return editPool(pools.find(function (p) { return p.id === b.dataset.poolEdit; })); }); });
        return loadCompReport();
      });
  };
  function renderPreview() {
    var p = state.preview || [], ok = p.filter(function (x) { return !x.problem; }).length, bad = p.length - ok;
    $("#cPreview").innerHTML = '<p role="status"><b>' + ok + "</b> ready to issue" + (bad ? ", <b>" + bad + "</b> with problems (will be skipped)" : "") + ".</p>" +
      '<div class="tablewrap"><table><thead><tr><th scope="col" class="num">Row</th><th scope="col">Email</th><th scope="col">Name</th><th scope="col">Check</th></tr></thead><tbody>' +
      (p.length ? p.map(function (x) { return '<tr class="' + (x.problem ? "bad" : "") + '"><td class="num">' + x.row + "</td><td>" + esc(x.email || "-") + "</td><td>" + esc(x.name || "-") + "</td><td>" + (x.problem ? pill(x.problem, "bad") : pill("OK", "ok")) + "</td></tr>"; }).join("") : emptyRow(4, "The list is empty.")) +
      "</tbody></table></div>";
  }
  function renderPools(pools) {
    $("#pTable").innerHTML = '<div class="tablewrap"><table><thead><tr><th scope="col">Pool</th><th scope="col">Ticket type</th><th scope="col">Owner</th><th scope="col">Used</th><th scope="col" class="num">Left</th><th scope="col"><span class="sr">Actions</span></th></tr></thead><tbody>' +
      (pools.length ? pools.map(function (p) {
        return "<tr><td>" + esc(p.name) + "</td><td>" + esc(typeLabel(p.ticket_type_id)) + "</td><td>" + esc(p.owner_email || "-") + "</td><td>" + meter(p.used || 0, p.allotment) +
          '</td><td class="num">' + n0(Math.max(0, (p.allotment || 0) - (p.used || 0))) + '</td><td><button type="button" class="btn ghost sm" data-pool-edit="' + esc(p.id) + '">Edit</button></td></tr>';
      }).join("") : emptyRow(6, "No pools yet. Pools cap how many comps a sponsor or team can hand out.")) + "</tbody></table></div>";
  }
  function editPool(p) {
    var d = p || {};
    return openDialog({
      title: p ? "Edit comp pool" : "New comp pool",
      body: '<div class="form">' + fld("f_name", "Pool name", "text", d.name, { required: true, wide: true, hint: "e.g. A. Lange & Sohne sponsor allotment" }) +
        fld("f_type", "Ticket type", "select", "", { html: typeOptions(d.ticket_type_id, "Any ticket type") }) +
        fld("f_allot", "Allotment", "number", d.allotment, { attrs: ' min="0" step="1"' }) + fld("f_owner", "Owner email", "email", d.owner_email, { hint: "Who manages this allotment" }) +
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
            (live ? '<button type="button" class="btn ghost sm" data-t-act="move" data-t="' + esc(t.id) + '">Move</button><button type="button" class="btn ghost sm" data-t-act="unlock_phone" data-t="' + esc(t.id) + '">Unlock phone</button><button type="button" class="btn ghost sm" data-t-act="remove" data-t="' + esc(t.id) + '">Remove</button>' : "") +
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
  function showToken(name, token) {
    return openDialog({
      title: "Tracker token for " + name,
      body: '<div class="notice warn" role="alert"><b>Copy this token now. It is shown only once</b> and cannot be looked up again. Anyone with it can move this vehicle on the guest map, so send it only to the driver or load it into the GPS device.</div>' +
        '<div class="tokenbox" id="tokenVal">' + esc(token) + '</div><div class="btns"><button type="button" class="btn" id="tokenCopy">Copy token</button><span id="tokenCopied" role="status" class="hint"></span></div>',
      buttons: [{ label: "I have saved it", value: "cancel", cls: "ghost" }],
      focusButton: true,
      onOpen: function (b) {
        $("#tokenCopy", b).addEventListener("click", function () {
          var done = function () { $("#tokenCopied", b).textContent = "Copied"; };
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(token).then(done, function () { $("#tokenCopied", b).textContent = "Copy failed. Select the token and copy it by hand."; });
          else { var r = document.createRange(); r.selectNodeContents($("#tokenVal", b)); getSelection().removeAllRanges(); getSelection().addRange(r); $("#tokenCopied", b).textContent = "Selected. Press Ctrl+C to copy."; }
        });
      }
    }).then(function () { $("#dlgBody").innerHTML = ""; token = null; });
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
        return (token ? showToken(vh.name, token) : Promise.resolve(toast("Vehicle saved"))).then(function () { return VIEWS.ops(); });
      });
    });
  }
  function rotateVehicle(vh) {
    return confirmAction({ title: "Issue a new token for " + vh.name + "?", danger: true, confirmLabel: "Issue new token",
      message: "The current token stops working straight away. The driver's phone or GPS device must be given the new token before it reports again." })
      .then(function (reason) {
        if (!reason) return;
        return rpc("ops", "admin_upsert_vehicle", { p_app: APP, p_vehicle: { id: vh.id, rotate_token: true, _reason: reason } }).then(function (res) {
          return res && res.tracker_token ? showToken(vh.name, res.tracker_token) : toast("Token reset");
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
})();
