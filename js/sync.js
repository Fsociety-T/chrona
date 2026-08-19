/* ═══════════════════════════════════════════════════════════════
   sync.js — Supabase auth + two-way sync, over plain fetch

   No SDK. Supabase's REST layer (PostgREST) and auth endpoints are
   ordinary HTTP, so the whole client is a few fetch calls — nothing
   to npm install, nothing extra in the APK.

   Model: local-first. IndexedDB is the source of truth the UI reads
   from, and it keeps working with no network at all. Sync reconciles
   in the background:

     push — every record with dirty=1 is upserted to the server
     pull — every server record changed since the last sync is merged

   Conflicts resolve last-write-wins on updated_at. Deletes are
   tombstones (deleted=1) so they propagate instead of being undone
   by the other device's next push.
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var LS = {
    url:      'chrona:sbUrl',
    key:      'chrona:sbKey',
    session:  'chrona:session',
    lastSync: 'chrona:lastSync',
    auto:     'chrona:autoSync'
  };

  var state = {
    url: null,
    anonKey: null,
    session: null,       // { access_token, refresh_token, expires_at, user }
    status: 'off',       // off | ready | syncing | ok | error | offline
    message: '',
    lastSync: 0,
    syncing: false,
    autoSync: true
  };

  var listeners = [];
  function on(fn) { listeners.push(fn); return function () { off(fn); }; }
  function off(fn) { listeners = listeners.filter(function (l) { return l !== fn; }); }
  function emit() { listeners.forEach(function (fn) { fn(state); }); }

  function setStatus(status, message) {
    state.status = status;
    state.message = message || '';
    emit();
  }

  /* ── stored config ────────────────────────────────────────── */
  function load() {
    // Anything saved in Settings wins; config.js supplies the default
    // so a fresh install is already pointed at the right project.
    var defaults = global.CHRONA_CONFIG || {};
    try {
      state.url = localStorage.getItem(LS.url) || defaults.SUPABASE_URL || null;
      state.anonKey = localStorage.getItem(LS.key) || defaults.SUPABASE_ANON_KEY || null;
      state.lastSync = parseInt(localStorage.getItem(LS.lastSync), 10) || 0;
      state.autoSync = localStorage.getItem(LS.auto) !== '0';
      var raw = localStorage.getItem(LS.session);
      if (raw) state.session = JSON.parse(raw);
    } catch (e) { /* storage blocked */ }

    state.status = configured() ? (signedIn() ? 'ready' : 'ready') : 'off';
    return state;
  }

  function configured() { return !!(state.url && state.anonKey); }
  function signedIn() { return !!(state.session && state.session.access_token); }
  function userEmail() { return state.session && state.session.user && state.session.user.email; }

  function setConfig(url, anonKey) {
    // Tolerate a trailing slash or a pasted dashboard URL.
    url = String(url || '').trim().replace(/\/+$/, '');
    anonKey = String(anonKey || '').trim();
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)) {
      return Promise.reject(new Error('That does not look like a Supabase project URL. It should look like https://abcdefgh.supabase.co'));
    }
    if (anonKey.length < 30) {
      return Promise.reject(new Error('That anon key looks too short. Copy the full "anon public" key from Project Settings → API.'));
    }
    state.url = url;
    state.anonKey = anonKey;
    try {
      localStorage.setItem(LS.url, url);
      localStorage.setItem(LS.key, anonKey);
    } catch (e) {}
    setStatus('ready', 'Connected. Sign in to start syncing.');
    return Promise.resolve(state);
  }

  function saveSession(session) {
    state.session = session;
    try {
      if (session) localStorage.setItem(LS.session, JSON.stringify(session));
      else localStorage.removeItem(LS.session);
    } catch (e) {}
    emit();
  }

  function setAutoSync(on) {
    state.autoSync = !!on;
    try { localStorage.setItem(LS.auto, on ? '1' : '0'); } catch (e) {}
    emit();
  }

  /* ── HTTP ─────────────────────────────────────────────────── */

  function request(path, opts) {
    opts = opts || {};
    var headers = Object.assign({
      'apikey': state.anonKey,
      'Content-Type': 'application/json'
    }, opts.headers || {});

    if (opts.auth !== false && signedIn()) {
      headers['Authorization'] = 'Bearer ' + state.session.access_token;
    } else {
      headers['Authorization'] = 'Bearer ' + state.anonKey;
    }

    return fetch(state.url + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        if (text) { try { data = JSON.parse(text); } catch (e) { data = text; } }
        if (!res.ok) {
          var msg = (data && (data.msg || data.message || data.error_description || data.error || data.hint)) ||
                    ('Request failed (' + res.status + ')');
          var err = new Error(msg);
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  /* ── auth ─────────────────────────────────────────────────── */

  function signUp(email, password) {
    if (!configured()) return Promise.reject(new Error('Connect your Supabase project first.'));
    return request('/auth/v1/signup', {
      method: 'POST', auth: false,
      body: { email: email, password: password }
    }).then(function (data) {
      // With email confirmation enabled, Supabase returns a user but no
      // session — nothing to sync until they click the link.
      if (data && data.access_token) {
        saveSession(normalizeSession(data));
        setStatus('ready', 'Account created.');
        return { needsConfirmation: false };
      }
      setStatus('ready', 'Check your email to confirm the account, then sign in.');
      return { needsConfirmation: true };
    });
  }

  function signIn(email, password) {
    if (!configured()) return Promise.reject(new Error('Connect your Supabase project first.'));
    return request('/auth/v1/token?grant_type=password', {
      method: 'POST', auth: false,
      body: { email: email, password: password }
    }).then(function (data) {
      saveSession(normalizeSession(data));
      setStatus('ready', 'Signed in.');
      return state.session;
    });
  }

  function signOut() {
    var done = function () {
      saveSession(null);
      state.lastSync = 0;
      try { localStorage.removeItem(LS.lastSync); } catch (e) {}
      setStatus('ready', 'Signed out. Your data stays on this device.');
    };
    if (!signedIn()) { done(); return Promise.resolve(); }
    return request('/auth/v1/logout', { method: 'POST' })
      .then(done, done);   // a failed logout still clears us locally
  }

  function normalizeSession(data) {
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      // expires_in is seconds from now; store an absolute ms deadline.
      expires_at: Date.now() + ((data.expires_in || 3600) * 1000),
      user: data.user || null
    };
  }

  /* Access tokens last an hour. Refresh a minute early rather than
     letting a sync fail on a token that expired mid-flight. */
  function ensureFreshToken() {
    if (!signedIn()) return Promise.reject(new Error('Not signed in.'));
    if (Date.now() < state.session.expires_at - 60000) return Promise.resolve();

    return request('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', auth: false,
      body: { refresh_token: state.session.refresh_token }
    }).then(function (data) {
      saveSession(normalizeSession(data));
    }).catch(function (err) {
      // Refresh token rejected — the session is genuinely dead.
      saveSession(null);
      throw new Error('Session expired. Please sign in again.');
    });
  }

  /* ── field mapping ────────────────────────────────────────── */
  /* Local records are camelCase; Postgres columns are snake_case.
     A couple of names also collide with SQL keywords. */

  /* `start`, `end` and `order` all collide with SQL keywords or reserved
     words, so those get explicit column names. Objectives sidestep the
     problem by using fromDay/toDay locally, which map cleanly. */
  var OVERRIDES = {
    entries:    { start: 'start_at', end: 'end_at' },
    activities: { order: 'sort_order' }
  };

  // Fields that live only on the client and must never be sent.
  var LOCAL_ONLY = { dirty: 1 };

  function camelToSnake(s) {
    return s.replace(/([A-Z])/g, function (m) { return '_' + m.toLowerCase(); });
  }

  function toRemote(table, rec) {
    var over = OVERRIDES[table] || {};
    var out = {};
    Object.keys(rec).forEach(function (k) {
      if (LOCAL_ONLY[k]) return;
      var col = over[k] || (k === 'updated_at' ? k : camelToSnake(k));
      var v = rec[k];
      if (k === 'deleted') v = !!v;
      out[col] = v;
    });
    return out;
  }

  function toLocal(table, row) {
    var over = OVERRIDES[table] || {};
    var back = {};
    Object.keys(over).forEach(function (localKey) { back[over[localKey]] = localKey; });

    var out = {};
    Object.keys(row).forEach(function (col) {
      if (col === 'user_id') return;            // server-side only
      var key = back[col] || (col === 'updated_at' ? col : snakeToCamel(col));
      var v = row[col];
      if (key === 'deleted') v = v ? 1 : 0;
      out[key] = v;
    });
    out.dirty = 0;                              // freshly from the server
    return out;
  }

  function snakeToCamel(s) {
    return s.replace(/_([a-z])/g, function (_, c) { return c.toUpperCase(); });
  }

  /* ── sync ─────────────────────────────────────────────────── */

  /* Local store name → Postgres table. Prefixed server-side because
     plain names like `tasks` collide with whatever else lives in the
     database, and `create table if not exists` fails silently when
     they do. */
  var TABLES = ['activities', 'entries', 'tasks', 'habits', 'checks', 'objectives'];
  function remoteTable(store) { return 'chrona_' + store; }

  function syncNow(opts) {
    opts = opts || {};
    if (state.syncing) return Promise.resolve(null);
    if (!configured()) return Promise.reject(new Error('Not connected to Supabase.'));
    if (!signedIn()) return Promise.reject(new Error('Not signed in.'));
    if (!navigator.onLine) {
      setStatus('offline', 'Offline — will sync when you reconnect.');
      return Promise.resolve(null);
    }

    state.syncing = true;
    setStatus('syncing', 'Syncing…');

    var report = { pushed: 0, pulled: 0, missing: [], tables: {} };
    // Captured before the work starts, so records changed *during* this
    // sync are not skipped by the next one.
    var startedAt = Date.now();

    return ensureFreshToken()
      .then(function () {
        return TABLES.reduce(function (chain, table) {
          return chain.then(function () { return syncTable(table, report); });
        }, Promise.resolve());
      })
      .then(function () {
        state.lastSync = startedAt;
        try { localStorage.setItem(LS.lastSync, String(startedAt)); } catch (e) {}
        state.syncing = false;
        setStatus('ok', describe(report));
        return Store.reload().then(function () { Store.emit(); return report; });
      })
      .catch(function (err) {
        state.syncing = false;
        setStatus('error', err.message || 'Sync failed');
        throw err;
      });
  }

  function describe(r) {
    var bits = [];
    if (r.pushed) bits.push('sent ' + r.pushed);
    if (r.pulled) bits.push('received ' + r.pulled);
    var main = bits.length ? bits.join(', ') : 'Up to date';

    if (r.missing && r.missing.length) {
      // Name the SQL file rather than the table, since that is the thing
      // they actually have to go and run.
      main += ' · ' + r.missing.join(', ') +
              ' not set up on the server yet (run supabase/02-objectives.sql)';
    }
    return main;
  }

  /* A table the server doesn't have yet — a migration SQL file that
     hasn't been run — must not take the whole sync down with it. Skip
     that one table, note it, and carry on with the rest. */
  function isMissingTable(err) {
    if (!err) return false;
    if (err.status === 404) return true;
    var msg = String(err.message || '');
    return /does not exist|Could not find the table|schema cache/i.test(msg);
  }

  function syncTable(table, report) {
    return pushTable(table, report)
      .then(function () { return pullTable(table, report); })
      .catch(function (err) {
        if (!isMissingTable(err)) throw err;
        report.missing.push(table);
        return null;
      });
  }

  /* Upload every locally-changed row. */
  function pushTable(table, report) {
    return DB.dirty(table).then(function (rows) {
      if (!rows.length) return;

      var payload = rows.map(function (r) { return toRemote(table, r); });

      // merge-duplicates makes this an upsert on the (user_id, id) key.
      return request('/rest/v1/' + remoteTable(table) + '?on_conflict=user_id,id', {
        method: 'POST',
        headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: payload
      }).then(function () {
        report.pushed += rows.length;
        // Clear the dirty flag only after the server has taken them.
        var clean = rows.map(function (r) { return Object.assign({}, r, { dirty: 0 }); });
        return DB.putAll(table, clean);
      });
    });
  }

  /* Download everything changed since the last successful sync. */
  function pullTable(table, report) {
    var since = state.lastSync || 0;
    var path = '/rest/v1/' + remoteTable(table) +
               '?select=*&updated_at=gt.' + since +
               '&order=updated_at.asc&limit=10000';

    return request(path).then(function (rows) {
      if (!rows || !rows.length) return;

      return Promise.all(rows.map(function (row) {
        var incoming = toLocal(table, row);
        return DB.get(table, incoming.id).then(function (local) {
          // Last write wins. A local row that is dirty and newer is left
          // alone — the next push will carry it up.
          if (local && (local.updated_at || 0) >= (incoming.updated_at || 0)) return null;
          return incoming;
        });
      })).then(function (winners) {
        var toWrite = winners.filter(Boolean);
        if (!toWrite.length) return;
        report.pulled += toWrite.length;
        return DB.putAll(table, toWrite);
      });
    });
  }

  /* First sync after signing in on a fresh device: pull everything. */
  function pullAll() {
    state.lastSync = 0;
    try { localStorage.removeItem(LS.lastSync); } catch (e) {}
    return syncNow();
  }

  /* Mark every local record for upload, then sync.

     Needed when you point the app at a *different* Supabase project.
     After a successful sync every record is dirty=0, so against an
     empty new project the next sync would push nothing and report
     "Up to date" — the app would look synced while the new project
     stayed empty. This re-flags everything so the new project gets the
     full history.

     Tombstones are re-flagged too: a delete that never reached the new
     project would otherwise be lost, and the row would come back the
     next time another device pushed it. */
  function reuploadAll() {
    if (!configured()) return Promise.reject(new Error('Not connected to Supabase.'));
    if (!signedIn()) return Promise.reject(new Error('Not signed in.'));

    setStatus('syncing', 'Preparing full upload…');

    var stores = DB.syncedStores();
    return stores.reduce(function (chain, name) {
      return chain.then(function () {
        return DB.all(name).then(function (rows) {
          if (!rows.length) return;
          var flagged = rows.map(function (r) {
            return Object.assign({}, r, { dirty: 1 });
          });
          return DB.putAll(name, flagged);
        });
      });
    }, Promise.resolve()).then(function () {
      // Reset the watermark too, so the pull half starts from scratch
      // rather than assuming the new project already has our history.
      state.lastSync = 0;
      try { localStorage.removeItem(LS.lastSync); } catch (e) {}
      return syncNow();
    });
  }

  /* ── automatic triggers ───────────────────────────────────── */

  var debounceHandle = null;

  /* Called on every local change. Debounced so a burst of edits becomes
     one request rather than a dozen. */
  function scheduleSync() {
    if (!state.autoSync || !configured() || !signedIn()) return;
    clearTimeout(debounceHandle);
    debounceHandle = setTimeout(function () {
      syncNow().catch(function () { /* status already reflects it */ });
    }, 4000);
  }

  function startAuto() {
    // Local changes.
    Store.on(scheduleSync);

    // Coming back online, and returning to the app.
    global.addEventListener('online', function () {
      if (state.status === 'offline') setStatus('ready', '');
      scheduleSync();
    });
    global.addEventListener('offline', function () {
      setStatus('offline', 'Offline — will sync when you reconnect.');
    });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) scheduleSync();
    });

    // A slow heartbeat, to pick up changes made on another device.
    setInterval(function () {
      if (!document.hidden) scheduleSync();
    }, 5 * 60 * 1000);

    if (signedIn()) scheduleSync();
  }

  global.Sync = {
    state: state, on: on, off: off,
    load: load, configured: configured, signedIn: signedIn, userEmail: userEmail,
    setConfig: setConfig, setAutoSync: setAutoSync,
    signUp: signUp, signIn: signIn, signOut: signOut,
    syncNow: syncNow, pullAll: pullAll, reuploadAll: reuploadAll,
    scheduleSync: scheduleSync, startAuto: startAuto,
    // exposed for tests
    _toRemote: toRemote, _toLocal: toLocal
  };
})(window);
