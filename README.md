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
| **Goals** | Objectives with a target and a deadline — "Deep work 40h this month". They fill up as you track, and achieved ones are kept |
| **Insights** | Whether you're improving, where the hours actually went, when you're at your best, and what to change — plus an optional AI read of it |

**Timed habits tick themselves off.** Set "Read — 30 min/day", and once you've
logged 30 minutes against it, it's marked done automatically.

**Objectives are never stored as a counter.** A goal's progress is recomputed
from your entries every time it's shown, so correcting a session, deleting one,
or moving it to another day updates the objective immediately. A stored total
would drift out of step the first time you fixed a mistake and then quietly stay
wrong.

The same honesty applies to the badge: if the time behind an achievement is
later removed or edited down, the achievement is revoked. It was never actually
earned, and leaving the tick there would be the app lying to you.

### Analysis

Every activity is classified by you as **productive**, **neutral**, or **draining**
— the app never guesses, because a wrong guess would quietly skew every
productivity figure derived from it. Insights then answers four questions:

- **Am I improving?** — this window against the one before it, with the movers named.
- **Where is my time going?** — the productive/draining split and time per task.
- **When am I at my best?** — peak hour, best *productive* hour (not the same
  thing), best weekday, typical and longest session.
- **What to change** — habits slipping, objectives behind pace with the daily
  rate needed to catch up, lopsided time, and wins worth noticing.

**How much of the day is recorded.** Every split and percentage on the Insights
screen describes the part of the day you actually tracked. A coverage strip under
the tiles says how big that part is — *"3h 20m of a 16h day"* — because *"100%
productive"* over three hours of sixteen is true and says almost nothing. Set your
day length in **Settings → Day length**; sleep is excluded, so it is not counted
against you.

**Focus quality** measures the shape of the time rather than its size. Four hours
in two sittings and four hours in fourteen are identical everywhere else in the
app: longest unbroken block, how much productive time came in blocks of 45
minutes or more, blocks per productive hour, activity switches a day, and the
median clock time your day starts.

These are computed on *blocks*, not entries. Pausing writes the open segment and
starts a new one, so one session with a coffee break is stored as two entries —
counting entries would measure how often you pause rather than how long you
focus. Consecutive entries on the same activity less than three minutes apart are
merged back into one block.

Anything with nothing to divide by reports absence rather than zero. "No
productive time yet" and "0%" look identical on a chart and mean opposite things.

**Suggesting the kinds.** Activities → *Suggest kinds with AI* asks a model to
label each one, and shows you what it proposes: the current kind, the suggested
one, and a one-line reason. It applies nothing until you press Apply, and rows
it would not change are shown but not selected.

It proposes rather than decides for the same reason the app made you choose in
the first place. This one field feeds every productivity number here, so a
wrong value does not look like an error — it looks like a worse week. Anything
genuinely ambiguous comes back "neutral", and names the model did not answer
for are listed rather than quietly left alone. The reply is validated against
the names actually sent and the three kinds that exist, so an invented activity
or an invented kind is dropped instead of written.

All of it is computed in the browser from your own entries
([js/analyse.js](js/analyse.js)) — offline, free, and instant. Two rules keep it
honest: a percentage against a zero baseline reads as "no comparison yet" rather
than infinite growth, and colour means *"this went the way you'd want"* rather
than *"this went up"* — so more of a draining activity shows red, not green.

### AI analysis (optional)

Insights can send its **summary** — never your raw history — to a model and ask
what stands out. The summary is around 1–2 KB, so a run costs a fraction of a cent.

The reply streams: tokens are painted as the model produces them, so the first
words land in about a second instead of after the whole analysis is written. It
is a real stream, not a typewriter replayed over finished text — animating a
completed response would make the wait longer and the motion a lie. A client
that cannot read a stream, or one whose stream dies before the first token,
falls back to a single buffered request.

The four sections are coloured by position rather than by matching their
headings, so a model that rephrases one still lands on the right colour, and
every figure is picked out of the prose — which only works because durations
arrive pre-formatted rather than as raw milliseconds.

The key never touches this app. It lives in a Supabase Edge Function
([supabase/functions/analyse/index.ts](supabase/functions/analyse/index.ts))
which verifies your Supabase session before spending anything, so the URL is not
an open relay for whoever finds it.

```bash
supabase functions deploy analyse
supabase secrets set GROQ_API_KEY=gsk_...
supabase secrets set GROQ_MODEL=openai/gpt-oss-120b       # optional
```

Groq retires models on a schedule, and a retired name comes back as a 404
that reads like a broken feature rather than a dead model — which is exactly
what happened to `llama-3.3-70b-versatile` on 2026-08-16.

So the model name is a starting guess, not a dependency. If Groq refuses it,
the function asks your account what it *can* serve, retries once, and tells
you in the panel which model it used instead. Setting `GROQ_MODEL` pins one
and skips the guessing.

**No CLI?** `.github/workflows/functions.yml` does the deploy on GitHub's
servers instead. Add a `SUPABASE_ACCESS_TOKEN` repo secret (from
<https://supabase.com/dashboard/account/tokens>) and every push that touches
`supabase/functions/**` redeploys.

It reads the target project out of `js/config.js` rather than taking it as
configuration, so the function always lands on the project the app actually
talks to — a function deployed to one project while the app points at another
is a 404 that looks like a broken feature. After deploying it calls the live
function once to prove it answers, and says so if `GROQ_API_KEY` is missing.

The secrets still belong in the dashboard (**Edge Functions → Secrets**). They
are deliberately not set from CI: that would mean a second copy of your Groq
key living in GitHub.

> **Never paste an API key into the app.** Chrona has no field for one and never
> will. A key that reaches the browser is a key in a public bundle.

### Cards you can keep

Every objective can be saved as an image. There are two, same frame, different
voice:

- a **commitment card** for an objective still running — what you're going to
  do, and who you're trying to become
- a **certificate** for one you've achieved — what you did, and when

Both carry your name and a line you write yourself: *I want to be — "a person
who finishes what they start"*. Edit it in the sheet and the preview redraws as
you type; the card can be dark or light independently of the app, because a
dark card is not what you want on a printed page.

They're drawn on a `<canvas>` in [js/certificate.js](js/certificate.js) and
exported as PNG — no library, no server, no fonts to fetch. It works offline and
adds nothing to the APK. Long names shrink to fit and long ambitions wrap and
ellipsise rather than spilling out of the frame.

### Focus mode

Off by default. Turn it on in Settings and starting a timer hands the whole
screen to one thing: the activity, the clock, and two buttons. Tasks, habits,
the timeline and the nav are all behind it.

**It cannot lock your phone or block other apps.** No web page can, in any
browser, and one that claimed otherwise would be lying to you. What it does is
remove every accidental way out of a session inside Chrona, hold the screen
awake while it runs, and count the times you left — a number you have to look
at afterwards does more work than a door you cannot open.

Leaving is a deliberate press-and-hold, not a tap, and Escape is swallowed here
rather than dismissing it. Leaving is also not stopping: the timer keeps running
and the live bar takes you back in. Finishing or pausing are done from inside.

The objectives the current activity feeds are shown under the clock, so the bar
moving is visible while you sit through the session rather than waiting on the
Goals screen behind the veil. Only objectives this activity counts towards, at
most three, activity-specific ones first.

An hours objective ticks up live, because objectiveProgress already folds the
open segment into its total. A sessions objective does not, and should not: a
session you have not finished is not a session yet, and counting it would let
the number drop back when a short one is discarded.

A session restored after a reload comes straight back to the focus screen, since
the decision is made from the running session rather than from what happened to
raise it in the first place.

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
2. In the dashboard: **SQL Editor → New query**, paste all of
   [supabase/setup.sql](supabase/setup.sql), and run it. That is the whole
   backend — seven tables, indexes, row-level security, and the guard trigger.

   > The numbered files (`00-repair`, `schema`, `02-objectives`,
   > `03-activity-kind`) exist only to bring a project that was set up
   > incrementally up to date. On a new project, ignore them — `00-repair`
   > will report that there is nothing to repair.

   > Tables are prefixed `chrona_` on purpose. Plain names like `tasks` are
   > common, and `create table if not exists` on an existing name does nothing
   > while still reporting success — which leaves the app talking to unrelated
   > tables with incompatible types. The script also ends with a check that
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

### Moving to a different Supabase project

Paste the new URL and anon key into **Settings → Cloud sync → Connect
Supabase**, create an account there, then use **Settings → Cloud sync →
Re-upload everything**.

Changing the URL signs you out on purpose. A session token is issued by one
project and means nothing to another, so keeping it would leave the app
showing you as signed in while every request came back 401 from a project
that had never seen that token. The stored sync cursor is dropped for the
same reason — it points into the old project's timeline.

`js/config.js` holds the default for a *fresh* install. Anything entered in
Settings overrides it, so editing it does not move a browser that has already
connected somewhere.

The re-upload is not optional. After a successful sync every local record is
marked clean, so against an empty new project a normal sync pushes nothing and
reports "Up to date" — the app would look synced while the new project stayed
empty. Re-upload re-flags every record, tombstones included, so deletions don't
get resurrected later by another device.

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

Black soft-depth — minimal 3D — held together by two rules.

**Every surface is a solid pressed out of the background.** Raised things are
objects, sunken things are holes: cards, buttons and chips are extruded, while
tracks, grooves, inputs and the timer dial are inset. Pressing a control inverts
its shadows so it physically pushes in. One light source, top-left, throughout.

**The interface is monochrome; colour means data.** The depth is built from
black, white and greys alone, so the only saturated colour in the app comes from
your activities — the day bar, the legend and the charts are what your eye lands
on, and a colour on screen always tells you something rather than just
decorating.

The background is near-black rather than pure `#000`, because clay needs a
surface slightly lighter than its ground to catch the light; at pure black there
is nothing for a highlight to sit against. Light mode is the same system
inverted. It is all CSS — no images, nothing that struggles on a mid-range
Android.

```
index.html              app shell — all four screens live here
css/styles.css          the entire visual system
js/db.js                IndexedDB layer (stores, indexes, export/import)
js/sound.js             synthesized audio cues (no audio files)
js/store.js             state, the timer engine, every data operation
js/analyse.js           the analysis engine — all computed on-device
js/sync.js              Supabase auth + two-way sync, over plain fetch
js/certificate.js       objective cards drawn on canvas, exported as PNG
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
