/* ═══════════════════════════════════════════════════════════════
   analyse — Supabase Edge Function (Deno)

   Proxies one chat-completion call to Groq.

   The whole point of this function is that GROQ_API_KEY lives here, in
   Supabase's secret store, and nowhere else. The browser never sees it
   and it is never committed. The browser sends its Supabase session
   token; this function verifies that token, then makes the Groq call
   with a key the client has no access to.

   Deploy:
     supabase functions deploy analyse
   Set the key (once, and never in the repo):
     supabase secrets set GROQ_API_KEY=gsk_...
   ═══════════════════════════════════════════════════════════════ */

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const MODELS_URL = 'https://api.groq.com/openai/v1/models';

/* Groq retires models on a schedule. llama-3.3-70b-versatile was the
   default here until it was decommissioned on 2026-08-16, and the feature
   died with it: Groq answers a retired name with a 404, which surfaces as
   "the analysis is broken" rather than "that model is gone".

   So the name below is a starting guess, not a dependency. If it is ever
   refused, the function asks the account what it can actually serve and
   retries — see resolveModel(). Pin one explicitly to skip all of that:
     supabase secrets set GROQ_MODEL=... */
const DEFAULT_MODEL = 'openai/gpt-oss-120b';

/* Preference order when falling back. Anything not listed still gets used
   if it is all the account has — this only decides which of several. */
const FALLBACK_ORDER = [
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'groq/compound',
  'groq/compound-mini',
];

/* The model list also carries speech, embedding and moderation models —
   none of which can answer a chat completion. */
const NOT_CHAT = /whisper|tts|embed|guard|moderation/i;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

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
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);

  const groqKey = Deno.env.get('GROQ_API_KEY');
  if (!groqKey) {
    return json({
      error: 'GROQ_API_KEY is not set on this function. Run: supabase secrets set GROQ_API_KEY=gsk_...',
    }, 500);
  }

  /* Require a signed-in Supabase user. Without this the function is an
     open relay: anyone who finds the URL spends your Groq credit. */
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'Sign in first.' }, 401);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !anonKey) {
    return json({ error: 'Function is missing SUPABASE_URL / SUPABASE_ANON_KEY.' }, 500);
  }

  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
  });
  if (!userRes.ok) return json({ error: 'That session is not valid. Sign in again.' }, 401);

  let payload: { summary?: unknown; question?: string };
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

  /* One chat-completion attempt. Split out so the retry below is a second
     call rather than a second copy of the request. */
  async function callGroq(model: string) {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${groqKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        max_tokens: 900,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
      }),
    });
    return { res, raw: await res.text() };
  }

  /* Groq's own message is worth keeping — "model not found" and "invalid
     key" are the two failures you want to read verbatim. */
  function groqDetail(raw: string) {
    try { return JSON.parse(raw)?.error?.message ?? raw.slice(0, 400); }
    catch { return raw.slice(0, 400); }
  }

  /* A retired model and a bad key both fail the request, but only the
     first is worth retrying — so match on what Groq says, not on status
     alone. Retrying a bad key would spend two requests to fail twice. */
  function modelIsGone(status: number, detail: string) {
    return status === 404 || /does not exist|decommissioned|deprecat|no longer/i.test(detail);
  }

  /* Ask the account what it can actually serve. Returns null on any
     trouble: a failed lookup must not replace Groq's original error,
     which is more useful than anything this could say instead. */
  async function resolveModel(exclude: string): Promise<string | null> {
    let ids: string[] = [];
    try {
      const res = await fetch(MODELS_URL, { headers: { Authorization: `Bearer ${groqKey}` } });
      if (!res.ok) return null;
      const data = JSON.parse(await res.text())?.data;
      if (!Array.isArray(data)) return null;
      ids = data.map((m: { id?: string }) => m?.id).filter((id: unknown): id is string => !!id);
    } catch { return null; }

    const chat = ids.filter((id) => !NOT_CHAT.test(id) && id !== exclude);
    return FALLBACK_ORDER.find((want) => chat.includes(want)) ?? chat[0] ?? null;
  }

  let model = Deno.env.get('GROQ_MODEL') ?? DEFAULT_MODEL;
  let note: string | null = null;

  let attempt: { res: Response; raw: string };
  try {
    attempt = await callGroq(model);
  } catch (e) {
    return json({ error: 'Could not reach Groq: ' + (e as Error).message }, 502);
  }

  if (!attempt.res.ok && modelIsGone(attempt.res.status, groqDetail(attempt.raw))) {
    const alt = await resolveModel(model);
    if (alt) {
      try {
        attempt = await callGroq(alt);
        note = `${model} is no longer available on this account, so ${alt} was used instead. Set GROQ_MODEL to choose deliberately.`;
        model = alt;
      } catch (e) {
        return json({ error: 'Could not reach Groq: ' + (e as Error).message }, 502);
      }
    }
  }

  if (!attempt.res.ok) {
    return json({
      error: `Groq returned ${attempt.res.status}: ${groqDetail(attempt.raw)}`,
      model,
    }, 502);
  }

  let text = '';
  let usage: unknown = null;
  try {
    const data = JSON.parse(attempt.raw);
    text = data?.choices?.[0]?.message?.content ?? '';
    usage = data?.usage ?? null;
  } catch {
    return json({ error: 'Groq returned a response that could not be parsed.' }, 502);
  }

  if (!text.trim()) return json({ error: 'Groq returned an empty analysis.', model }, 502);

  return json({ text, model, usage, note });
});
