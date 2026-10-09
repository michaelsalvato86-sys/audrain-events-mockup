/* Back-end connector for the Audrain / Newport Life apps (Supabase). Master copy:
   audrain-apps/backend/client/sb.js - copy it unchanged into each app folder.
   The page sets window.SB_CONFIG = {url, anon, app, storageKey, guest} before loading this file.
     app        - 'concours' | 'winterfest' | 'dinnerclub' (the app value in the database)
     storageKey - unique per app: all the apps share one web origin, so sessions must not collide
     guest      - true for attendee apps: every phone gets a silent guest account so tickets can lock to it
   Nothing here is secret: the anon key is public by design and the database enforces every rule.
   If the network or the back end is down, SB.ok stays false and the app keeps its offline/demo behaviour. */
(function () {
  "use strict";
  var CFG = window.SB_CONFIG || {};
  var LIB = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js";
  var SB = window.SB = { ok: false, app: CFG.app, client: null, user: null, _subs: [] };

  function loadLib() {
    return new Promise(function (res, rej) {
      if (window.supabase && window.supabase.createClient) return res();
      var s = document.createElement("script"); s.src = LIB; s.async = true;
      s.onload = function () { res(); }; s.onerror = function () { rej(new Error("Could not reach the server")); };
      document.head.appendChild(s);
    });
  }
  function emit() { SB._subs.forEach(function (fn) { try { fn(SB.user); } catch (e) { console.error(e); } }); }

  SB.ready = loadLib().then(function () {
    SB.client = window.supabase.createClient(CFG.url, CFG.anon, {
      auth: { storageKey: CFG.storageKey || ("sb-" + CFG.app), persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
    });
    SB.client.auth.onAuthStateChange(function (_ev, session) { SB.user = session ? session.user : null; emit(); });
    return SB.client.auth.getSession();
  }).then(function (r) {
    SB.user = r.data.session ? r.data.session.user : null;
    if (!SB.user && CFG.guest) return SB.client.auth.signInAnonymously().then(function (a) {
      if (a.error) throw a.error; SB.user = a.data.user;
    });
  }).then(function () { SB.ok = true; emit(); return SB; })
    .catch(function (e) { console.warn("[SB] offline:", e && e.message); SB.ok = false; return SB; });

  /* fn(user) runs now (once ready) and on every sign-in / sign-out. */
  SB.onAuth = function (fn) { SB._subs.push(fn); SB.ready.then(function () { fn(SB.user); }); };
  SB.isGuest = function () { return !SB.user || !!SB.user.is_anonymous; };
  SB.email = function () { return SB.user && !SB.user.is_anonymous ? SB.user.email : null; };

  function fail(error) { var e = new Error(friendly(error)); e.raw = error; throw e; }
  function friendly(err) {
    var m = (err && (err.message || err.error_description)) || "Something went wrong";
    if (/Invalid login credentials/i.test(m)) return "Email or password is wrong";
    if (/already (been )?registered|already exists/i.test(m)) return "That email already has an account. Sign in instead.";
    if (/Password should be/i.test(m)) return "Use at least 8 characters for the password";
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return "No connection. Try again in a moment.";
    return m;
  }
  function need() { if (!SB.ok) throw new Error("No connection to the server right now"); }

  /* Email + password. A guest who creates an account keeps their tickets (same user, now with an email). */
  SB.signIn = function (email, password) {
    return SB.ready.then(function () { need(); return SB.client.auth.signInWithPassword({ email: String(email).trim().toLowerCase(), password: password }); })
      .then(function (r) { if (r.error) fail(r.error); SB.user = r.data.user; emit(); return SB.user; });
  };
  SB.signUp = function (email, password) {
    email = String(email).trim().toLowerCase();
    return SB.ready.then(function () {
      need();
      if (SB.user && SB.user.is_anonymous) return SB.client.auth.updateUser({ email: email, password: password });
      return SB.client.auth.signUp({ email: email, password: password });
    }).then(function (r) { if (r.error) fail(r.error); SB.user = r.data.user; emit(); return SB.user; });
  };
  SB.signOut = function () {
    return SB.ready.then(function () { need(); return SB.client.auth.signOut(); }).then(function () {
      SB.user = null;
      if (CFG.guest) return SB.client.auth.signInAnonymously().then(function (a) { SB.user = a.data && a.data.user; });
    }).then(function () { emit(); });
  };

  /* Database calls. schema is 'tix' | 'staff' | 'club'. Errors come back as plain-English Error messages. */
  SB.rpc = function (schema, fn, args) {
    return SB.ready.then(function () { need(); return SB.client.schema(schema).rpc(fn, args || {}); })
      .then(function (r) { if (r.error) fail(r.error); return r.data; });
  };
  SB.select = function (schema, table, build) {
    return SB.ready.then(function () { need(); var q = SB.client.schema(schema).from(table).select("*"); return build ? build(q) : q; })
      .then(function (r) { if (r.error) fail(r.error); return r.data; });
  };
  SB.insert = function (schema, table, row) {
    return SB.ready.then(function () { need(); return SB.client.schema(schema).from(table).insert(row).select(); })
      .then(function (r) { if (r.error) fail(r.error); return r.data && r.data[0]; });
  };
  SB.update = function (schema, table, match, patch) {
    return SB.ready.then(function () { need(); return SB.client.schema(schema).from(table).update(patch).match(match).select(); })
      .then(function (r) { if (r.error) fail(r.error); return r.data; });
  };
  /* Live inserts/updates on a table (staff chat, pings, announcements). Returns an unsubscribe function. */
  SB.live = function (schema, table, onRow) {
    var ch = null, stopped = false;
    SB.ready.then(function () {
      if (!SB.ok || stopped) return;
      ch = SB.client.channel("live-" + schema + "-" + table + "-" + Math.random().toString(36).slice(2))
        .on("postgres_changes", { event: "*", schema: schema, table: table }, function (p) { onRow(p.new, p.eventType, p.old); })
        .subscribe();
    });
    return function () { stopped = true; if (ch) SB.client.removeChannel(ch); };
  };
})();
