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

/* Overridable without redeploying: `supabase secrets set GROQ_MODEL=...`
   Check what your account can serve at https://api.groq.com/openai/v1/models */
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

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

  const model = Deno.env.get('GROQ_MODEL') ?? DEFAULT_MODEL;

  let groqRes: Response;
  try {
    groqRes = await fetch(GROQ_URL, {
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
  } catch (e) {
    return json({ error: 'Could not reach Groq: ' + (e as Error).message }, 502);
  }

  const raw = await groqRes.text();
  if (!groqRes.ok) {
    // Surface Groq's own message — "model not found" and "invalid key"
    // are the two failures worth seeing verbatim while setting this up.
    let detail = raw.slice(0, 400);
    try { detail = JSON.parse(raw)?.error?.message ?? detail; } catch { /* keep raw */ }
    return json({ error: `Groq returned ${groqRes.status}: ${detail}`, model }, 502);
  }

  let text = '';
  let usage: unknown = null;
  try {
    const data = JSON.parse(raw);
    text = data?.choices?.[0]?.message?.content ?? '';
    usage = data?.usage ?? null;
  } catch {
    return json({ error: 'Groq returned a response that could not be parsed.' }, 502);
  }

  if (!text.trim()) return json({ error: 'Groq returned an empty analysis.', model }, 502);

  return json({ text, model, usage });
});
