/* ═══════════════════════════════════════════════════════════════
   analyse — Supabase Edge Function (Deno)

   Proxies one chat-completion call to Groq and streams the reply back.

   The whole point of this function is that GROQ_API_KEY lives here, in
   Supabase's secret store, and nowhere else. The browser never sees it
   and it is never committed. The browser sends its Supabase session
   token; this function verifies that token, then makes the Groq call
   with a key the client has no access to.

   Auth, CORS and the Groq call itself live in ../_shared/groq.ts, so a
   model retirement is fixed in one place rather than once per function.

   Deploy: handled by .github/workflows/functions.yml
   Set the key (once, and never in the repo) in the Supabase dashboard
   under Edge Functions → Secrets, or:
     supabase secrets set GROQ_API_KEY=gsk_...
   ═══════════════════════════════════════════════════════════════ */

import {
  CORS, json, preflight, groqKey, missingKey, requireUser, chat,
} from '../_shared/groq.ts';

/* The prompt is deliberately specific about what NOT to do. A generic
   "analyse this data" request produces horoscope output — restating the
   numbers the user can already see, hedged into uselessness. */
const SYSTEM_PROMPT = `
You analyse one person's time-tracking data and tell them something they
cannot see by looking at their own charts.

You are given a JSON summary: totals for a window and the window before
it, time split into productive/neutral/draining (the user classified
their own activities), per-activity movement, time-of-day and weekday
patterns, top tasks, habit completion, active objectives, and findings
already computed on-device.

It also carries two things the totals cannot show:

- "coverage": how much of the day was recorded at all. Every split and
  percentage describes only that recorded part.
- "focus": the shape of the time — longest unbroken block, how much of
  the productive time came in long blocks, how fragmented it was, and
  how often the person switched activities.

Write four short sections, in this order, with these exact headings:

## Am I improving?
## Where is my time going?
## When am I at my best?
## What to change

Rules:
- Ground every claim in a number from the data, and name it.
- Durations are already written for a reader ("16 min", "2h 5m"). Quote them
  exactly as given. Never restate one in milliseconds or any other unit.
- Use only percentages that appear in the data. Do not derive your own from
  two numbers. Where a "change" field says there is no usable baseline, that
  is the finding — report it as such instead of computing a percentage.
- Attach every number to the thing it belongs to. A window total is not an
  activity total, and one activity's change is not another's.
- Never mention a field name from the JSON. Write "your busiest hour is
  14:00-15:00", not "bestHour = 14".
- Do not restate the whole dataset back. Pick what matters.
- Before quoting any share of time as productive or draining, say what
  share of the day was recorded. "80% of a recorded 3h of a 16h day" is
  the honest form; "80% of your time" is not.
- Under "Where is my time going?", use the shape as well as the totals.
  The same hours arriving in two blocks or fourteen is the finding.
- Treat a fragmentation or switching figure as worth acting on only when
  there is at least an hour of productive time behind it.
- Where a focus field says there is nothing to measure, say that plainly
  rather than reporting it as a zero.
- Say plainly when the data is too thin to support a conclusion. A
  window with two tracked days cannot show a trend; say so rather than
  inventing one.
- "What to change" must be at most three concrete actions tied to the
  data — an hour to protect, a habit to rescue, an objective needing a
  specific daily pace. No generic productivity advice.
- Address the person as "you". No preamble, no sign-off, no emoji.
- Be direct about bad news, and equally direct about progress. If they
  are doing well, say so without padding.
- Under 300 words total.
`.trim();

Deno.serve(async (req: Request) => {
  const early = preflight(req);
  if (early) return early;

  const key = groqKey();
  if (!key) return missingKey();

  const denied = await requireUser(req);
  if (denied) return denied;

  let payload: { summary?: unknown; question?: string; stream?: boolean };
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Body must be JSON.' }, 400);
  }
  if (!payload.summary) return json({ error: 'Missing "summary".' }, 400);

  // Bound the payload — a corrupted or hostile client shouldn't be able
  // to bill an enormous prompt to the account.
  const summaryText = JSON.stringify(payload.summary);
  if (summaryText.length > 60000) {
    return json({ error: 'That summary is too large to analyse.' }, 413);
  }

  const userContent = payload.question
    ? `${summaryText}\n\nThe person also asked: ${String(payload.question).slice(0, 500)}`
    : summaryText;

  const wantsStream = payload.stream === true;

  const result = await chat({
    key,
    stream: wantsStream,
    temperature: 0.4,
    maxTokens: 900,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
  });

  if (!result.ok) return result.response;

  /* ── streaming ──
     Hand Groq's event stream straight to the browser. The point is the
     wait: the first words land in about a second instead of after the
     whole analysis is written, which is the difference between watching
     something happen and staring at a spinner.

     The model and any fallback note travel as headers, since the body is
     no longer ours to put JSON in. Custom headers are invisible to fetch()
     across origins unless named in Access-Control-Expose-Headers, which is
     why CORS carries that. The note is percent-encoded: header values are
     ASCII-only and it contains an em dash. */
  if (wantsStream && result.res.body) {
    return new Response(result.res.body, {
      headers: {
        ...CORS,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Chrona-Model': result.model,
        'X-Chrona-Note': result.note ? encodeURIComponent(result.note) : '',
      },
    });
  }

  /* ── buffered ──
     Still here for clients that cannot read a stream, and as the fallback
     when one breaks mid-flight. */
  let text = '';
  let usage: unknown = null;
  try {
    const data = JSON.parse(await result.res.text()) as {
      choices?: { message?: { content?: string } }[];
      usage?: unknown;
    };
    text = data?.choices?.[0]?.message?.content ?? '';
    usage = data?.usage ?? null;
  } catch {
    return json({ error: 'Groq returned a response that could not be parsed.' }, 502);
  }

  if (!text.trim()) return json({ error: 'Groq returned an empty analysis.', model: result.model }, 502);

  return json({ text, model: result.model, usage, note: result.note });
});
