# Chrona

Track where your time actually goes — tasks, habits, and every hour of your day.

Most trackers let you tick a box and move on. Chrona is built on the opposite
idea: **everything you do gets a timer**. A task isn't done, it's *forty minutes
of your life*. A habit isn't checked, it's *thirty minutes of reading*. At the
end of the day you can see exactly where the hours went.

---

## Running it

You need [Node.js](https://nodejs.org) installed. Nothing else — the app itself
has zero dependencies.

```bash
node server.js
```

Then open **http://localhost:5173**.

The server also prints a `Network:` address. Open that on your phone (same
Wi-Fi) to use the app there before you build the APK.

> **Why not just double-click `index.html`?**
> Browsers block IndexedDB and service workers on `file://` URLs. The app will
> fall back to `localStorage` and still work, but you lose the real database and
> offline support. Use the server.

---

## How it works

**One timer runs at a time.** Starting a new one automatically stops and saves
the previous. That constraint is deliberate — it's what makes the daily totals
mean anything.

**The timer survives everything.** It's written to the database, not held in
memory, so closing the tab, reloading, or force-quitting the app on your phone
doesn't lose the session. Reopen and it's still counting.

**Pause splits a session into segments.** Each stretch of work becomes its own
entry the moment you pause, so the timeline and the day's totals are never
waiting on you to finish. Pausing for lunch gives you `09:00–12:00` and
`13:00–17:00`, not one row claiming seven hours across the middle of the day.

That also protects the invariant everything else leans on: for every entry,
`duration === end - start`. A single row spanning a break would quietly break
the midnight arithmetic, the overlap check and the day totals all at once.

**Four screens:**

| Screen | What it's for |
| --- | --- |
| **Today** | The live timer, quick-start chips, today's breakdown, and a timeline of every session |
| **Tasks** | Things to do. Hit ▶ on any task to time your work on it |
| **Habits** | Either a simple daily check, or *timed* with a minute target |
| **Insights** | Daily hours, time per activity, and which hours of the day you're actually active |

**Timed habits tick themselves off.** Set "Read — 30 min/day", and once you've
logged 30 minutes against it, it's marked done automatically.

### Sound

Short cues play as you use the app — rising notes on start, falling on stop, a
major arpeggio when you finish something, and a longer fanfare when a timed
habit reaches its daily target.

The tones are **synthesized in the browser** with the Web Audio API
([js/sound.js](js/sound.js)), not loaded from audio files. Nothing to download,
nothing to bundle, and it adds no weight to the APK.

Settings has a toggle, a volume slider, and buttons to preview each cue.

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` | Start, pause, or resume — whatever moves the session on |
| `x` | Stop the session |
| `1` `2` `3` `4` | Jump to Today / Tasks / Habits / Insights |
| `n` | New task or habit (on those screens) |
| `Esc` | Close the open sheet |

---

## Your data

Everything is stored locally in **IndexedDB** first, and the app works fully
offline with no account at all. Settings → **Export** writes a JSON file with
your entire history; **Import** restores it.

Optionally, you can sync to Supabase for backup and multi-device use.

## Cloud sync (optional)

Sync is **local-first**. IndexedDB stays the source of truth the UI reads from,
so starting a timer is instant and works with no signal. Supabase is a backup
and a sync channel on top of it — never something the app waits on.

There is **no SDK**: Supabase's auth and PostgREST endpoints are ordinary HTTP,
so [js/sync.js](js/sync.js) talks to them with plain `fetch`. Nothing to
install, nothing extra in the APK.

### Setting it up

1. Create a free project at [supabase.com](https://supabase.com).
2. In the dashboard: **SQL Editor → New query**. Run
   [supabase/00-repair.sql](supabase/00-repair.sql) first *only if you ran an
   earlier version of the schema*, then run
   [supabase/schema.sql](supabase/schema.sql). This creates the five
   `chrona_*` tables, the indexes, and the row-level security policies.

   > Tables are prefixed `chrona_` on purpose. Plain names like `tasks` are
   > common, and `create table if not exists` on an existing name does nothing
   > while still reporting success — which leaves the app talking to unrelated
   > tables with incompatible types. The schema also ends with a check that
   > raises an exception rather than failing silently.
3. Go to **Project Settings → API** and copy the **Project URL** and the
   **anon public** key.
4. In the app: **Settings → Cloud sync → Connect Supabase**, paste both, then
   create an account.

> The anon key is meant to be public — it identifies the project, not you.
> Row-level security is what protects your rows, and the schema enables it on
> every table with `auth.uid() = user_id` policies. Without step 2, the key
> would be unsafe; with it, your data is only readable by you.

### How conflicts are handled

| Situation | Result |
| --- | --- |
| Same record edited on two devices | Newest `updated_at` wins |
| Record deleted on one device | Tombstoned (`deleted = true`) so the delete propagates instead of being undone by the other device's next push |
| Edited offline | Marked `dirty`, pushed on reconnect |
| Same habit ticked on two devices, same day | A unique index keeps one live row, so the streak can't double-count |
| Device clock is wrong | The server clamps `updated_at` to its own time, so a bad clock can't win every conflict forever |

Sync runs automatically in the background, debounced a few seconds after a
change, on reconnect, and when you return to the app. **Sync now** and
**Re-download all** are in Settings if you want to force it.

---

## Building the Android APK

The APK is built **on GitHub's servers** — you don't need Android Studio, the
Android SDK, or Java installed locally.

1. Push this project to a GitHub repository.
2. Go to the **Actions** tab → **Build Android APK** → **Run workflow**.
3. When it finishes (~5 minutes), download `chrona-apk` from the run's
   Artifacts section.
4. Transfer the `.apk` to your phone and install it. You'll need to allow
   "install from unknown sources".

To cut a proper release instead, push a version tag:

```bash
git tag v1.0.0
git push origin v1.0.0
```

That builds the APK *and* publishes it as a downloadable GitHub Release.

> The APK is **debug-signed**, which is fine for installing on your own phone.
> Publishing to the Play Store requires a release keystore and a signing step —
> a separate task when you get there.

## Deploying the website

Push to `main`, then enable **Settings → Pages → Source: GitHub Actions**. The
`Deploy website` workflow publishes it automatically.

Once it's live, you can also just open the URL on your phone and use
**"Add to Home Screen"** — it installs as a PWA and works offline, without
needing the APK at all.

---

## Project layout

## The look

Black and flat, on one rule:

> **The interface is monochrome. Colour means data.**

Every surface, border, button and label is black, white, or a grey between them.
The only saturated colour in the app comes from your activities — so the stacked
day bar, the legend and the charts are what your eye lands on, and a colour on
screen always tells you something instead of just decorating.

Depth is hairline borders rather than shadows, and the background is true `#000`
so it goes properly dark on an OLED phone. Light mode is the same system
inverted. It is all CSS — no images, no blur filters, nothing that struggles on
a mid-range Android.

```
index.html              app shell — all four screens live here
css/styles.css          the entire visual system
js/db.js                IndexedDB layer (stores, indexes, export/import)
js/sound.js             synthesized audio cues (no audio files)
js/store.js             state, the timer engine, every data operation
js/sync.js              Supabase auth + two-way sync, over plain fetch
supabase/schema.sql     tables, indexes, row-level security policies
js/ui.js                DOM helpers, formatting, sheets, toasts
js/views.js             rendering for each screen + all forms
js/app.js               boot, routing, the one-second tick
sw.js                   service worker (offline)
server.js               zero-dependency dev server
tools/icon-lib.js       PNG encoder + the Chrona mark, drawn in code
tools/make-icons.js     generates the PWA icons
tools/android-icons.js  generates the Android launcher icons
tools/build-www.js      assembles www/ for packaging and deploy
```

No build step, no bundler, no framework. Edit a file, reload the page.
