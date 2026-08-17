/* ═══════════════════════════════════════════════════════════════
   db.js — IndexedDB layer
   A real local database: object stores, indexes, range queries.
   Falls back to an in-memory shim if IndexedDB is unavailable
   (e.g. opening the file straight off disk in some browsers).
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var DB_NAME = 'chrona';
  var DB_VERSION = 2;

  /* Stores
     activities : { id, name, color, icon, archived, order }
     entries    : { id, activityId, taskId, habitId, note, start, end, day }
                  `day` is 'YYYY-MM-DD' of the start — indexed for fast day/range reads
     tasks      : { id, title, notes, activityId, done, createdAt, completedAt, dueDay }
     habits     : { id, name, color, icon, type:'check'|'timed',
                    targetMin, days:[0-6], archived, createdAt }
     checks     : { id, habitId, day, doneAt }   — one per habit per completed day
     meta       : { key, value }                 — running timer, settings
  */

  /* Synced stores additionally carry, on every record:
       updated_at : epoch ms, for last-write-wins against the server
       dirty      : 1 when the record has local changes awaiting push
       deleted    : 1 for a tombstone (never hard-delete a synced row,
                    or other devices would just resurrect it)  */
  var STORES = {
    activities: { keyPath: 'id', sync: true,
                  indexes: [['order', 'order'], ['dirty', 'dirty'], ['updated_at', 'updated_at']] },
    entries:    { keyPath: 'id', sync: true,
                  indexes: [['day', 'day'], ['start', 'start'],
                            ['taskId', 'taskId'], ['habitId', 'habitId'],
                            ['activityId', 'activityId'],
                            ['dirty', 'dirty'], ['updated_at', 'updated_at']] },
    tasks:      { keyPath: 'id', sync: true,
                  indexes: [['done', 'done'], ['createdAt', 'createdAt'], ['dueDay', 'dueDay'],
                            ['dirty', 'dirty'], ['updated_at', 'updated_at']] },
    habits:     { keyPath: 'id', sync: true,
                  indexes: [['createdAt', 'createdAt'],
                            ['dirty', 'dirty'], ['updated_at', 'updated_at']] },
    checks:     { keyPath: 'id', sync: true,
                  indexes: [['habitId', 'habitId'], ['day', 'day'],
                            ['dirty', 'dirty'], ['updated_at', 'updated_at']] },
    meta:       { keyPath: 'key', indexes: [] }
  };

  var SYNCED = Object.keys(STORES).filter(function (n) { return STORES[n].sync; });

  var _db = null;
  var _memory = null; // fallback storage

  /* ── open ─────────────────────────────────────────────────── */
  function open() {
    return new Promise(function (resolve) {
      var idb = global.indexedDB;
      if (!idb) { useMemoryFallback(); return resolve(false); }

      var req;
      try { req = idb.open(DB_NAME, DB_VERSION); }
      catch (e) { useMemoryFallback(); return resolve(false); }

      req.onupgradeneeded = function (ev) {
        var db = ev.target.result;
        var oldVersion = ev.oldVersion || 0;

        Object.keys(STORES).forEach(function (name) {
          var spec = STORES[name];
          var store = db.objectStoreNames.contains(name)
            ? ev.target.transaction.objectStore(name)
            : db.createObjectStore(name, { keyPath: spec.keyPath });
          spec.indexes.forEach(function (ix) {
            if (!store.indexNames.contains(ix[0])) store.createIndex(ix[0], ix[1]);
          });
        });

        // v1 → v2: existing records predate sync. Stamp them so the first
        // push uploads everything the user already has rather than losing it.
        if (oldVersion > 0 && oldVersion < 2) {
          var now = Date.now();
          SYNCED.forEach(function (name) {
            var store = ev.target.transaction.objectStore(name);
            store.openCursor().onsuccess = function (e) {
              var cursor = e.target.result;
              if (!cursor) return;
              var rec = cursor.value;
              if (rec.updated_at == null) {
                rec.updated_at = now;
                rec.dirty = 1;
                rec.deleted = 0;
                cursor.update(rec);
              }
              cursor.continue();
            };
          });
        }
      };

      req.onsuccess = function () {
        _db = req.result;
        _db.onversionchange = function () { _db.close(); _db = null; };
        resolve(true);
      };

      req.onerror = function () { useMemoryFallback(); resolve(false); };
      // Some browsers just never fire either handler on file:// — don't hang forever.
      setTimeout(function () {
        if (!_db && !_memory) { useMemoryFallback(); resolve(false); }
      }, 2500);
    });
  }

  function useMemoryFallback() {
    if (_memory) return;
    _memory = {};
    Object.keys(STORES).forEach(function (n) { _memory[n] = new Map(); });
    // Try to rehydrate from localStorage so data at least survives a reload.
    try {
      var raw = global.localStorage.getItem('chrona:fallback');
      if (raw) {
        var data = JSON.parse(raw);
        Object.keys(data).forEach(function (n) {
          if (!_memory[n]) return;
          data[n].forEach(function (rec) {
            _memory[n].set(rec[STORES[n].keyPath], rec);
          });
        });
      }
    } catch (e) { /* ignore corrupt fallback */ }
    console.warn('[chrona] IndexedDB unavailable — using localStorage fallback.');
  }

  function persistFallback() {
    if (!_memory) return;
    try {
      var out = {};
      Object.keys(_memory).forEach(function (n) {
        out[n] = Array.from(_memory[n].values());
      });
      global.localStorage.setItem('chrona:fallback', JSON.stringify(out));
    } catch (e) { /* quota or disabled storage — nothing we can do */ }
  }

  /* ── low-level helpers ────────────────────────────────────── */
  function tx(store, mode) {
    return _db.transaction(store, mode).objectStore(store);
  }

  function wrap(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  /* ── CRUD ─────────────────────────────────────────────────── */
  function put(store, record) {
    if (_memory) {
      _memory[store].set(record[STORES[store].keyPath], record);
      persistFallback();
      return Promise.resolve(record);
    }
    return wrap(tx(store, 'readwrite').put(record)).then(function () { return record; });
  }

  function putAll(store, records) {
    if (_memory) {
      records.forEach(function (r) { _memory[store].set(r[STORES[store].keyPath], r); });
      persistFallback();
      return Promise.resolve(records);
    }
    return new Promise(function (resolve, reject) {
      var t = _db.transaction(store, 'readwrite');
      var s = t.objectStore(store);
      records.forEach(function (r) { s.put(r); });
      t.oncomplete = function () { resolve(records); };
      t.onerror = function () { reject(t.error); };
    });
  }

  function get(store, key) {
    if (_memory) return Promise.resolve(_memory[store].get(key) || null);
    return wrap(tx(store, 'readonly').get(key)).then(function (r) { return r || null; });
  }

  function all(store) {
    if (_memory) return Promise.resolve(Array.from(_memory[store].values()));
    return wrap(tx(store, 'readonly').getAll());
  }

  function del(store, key) {
    if (_memory) {
      _memory[store].delete(key);
      persistFallback();
      return Promise.resolve();
    }
    return wrap(tx(store, 'readwrite').delete(key));
  }

  function clear(store) {
    if (_memory) { _memory[store].clear(); persistFallback(); return Promise.resolve(); }
    return wrap(tx(store, 'readwrite').clear());
  }

  /* Query an index by a [lo, hi] inclusive range — used for day ranges. */
  function range(store, indexName, lo, hi) {
    if (_memory) {
      var out = Array.from(_memory[store].values()).filter(function (r) {
        var v = r[indexName];
        return v != null && v >= lo && v <= hi;
      });
      return Promise.resolve(out);
    }
    var idx = tx(store, 'readonly').index(indexName);
    return wrap(idx.getAll(IDBKeyRange.bound(lo, hi)));
  }

  /* Query an index for one exact value. */
  function where(store, indexName, value) {
    if (_memory) {
      return Promise.resolve(
        Array.from(_memory[store].values()).filter(function (r) { return r[indexName] === value; })
      );
    }
    var idx = tx(store, 'readonly').index(indexName);
    return wrap(idx.getAll(IDBKeyRange.only(value)));
  }

  /* ── whole-database export / import (backup) ──────────────── */
  function exportAll() {
    var names = Object.keys(STORES);
    return Promise.all(names.map(function (n) { return all(n); })).then(function (results) {
      var dump = { app: 'chrona', version: DB_VERSION, exportedAt: new Date().toISOString(), data: {} };
      names.forEach(function (n, i) { dump.data[n] = results[i]; });
      return dump;
    });
  }

  function importAll(dump) {
    if (!dump || !dump.data) return Promise.reject(new Error('Not a Chrona backup file.'));
    var names = Object.keys(STORES).filter(function (n) { return dump.data[n]; });
    return Promise.all(names.map(function (n) { return clear(n); })).then(function () {
      return Promise.all(names.map(function (n) { return putAll(n, dump.data[n]); }));
    });
  }

  function wipe() {
    return Promise.all(Object.keys(STORES).map(function (n) { return clear(n); }));
  }

  /* Records with local changes awaiting push. IndexedDB cannot index a
     boolean, hence dirty being 1/0 rather than true/false. */
  function dirty(store) {
    return where(store, 'dirty', 1);
  }

  global.DB = {
    open: open, put: put, putAll: putAll, get: get, all: all,
    del: del, clear: clear, range: range, where: where, dirty: dirty,
    exportAll: exportAll, importAll: importAll, wipe: wipe,
    syncedStores: function () { return SYNCED.slice(); },
    usingFallback: function () { return !!_memory; }
  };
})(window);
