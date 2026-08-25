/* ═══════════════════════════════════════════════════════════════
   classify — Supabase Edge Function (Deno)

   Proposes productive / neutral / draining for a list of activities.

   Chrona has always made you classify your own activities, because this
   one field feeds every productivity number the app produces and a wrong
   value skews all of them quietly. That reasoning does not go away
   because a model is doing the typing, so this function *proposes* and
   the app makes you confirm. Nothing here writes anything.

   Deploy: handled by .github/workflows/functions.yml
   ═══════════════════════════════════════════════════════════════ */

import {
  CORS, json, preflight, groqKey, missingKey, requireUser, chat, textOf,
} from '../_shared/groq.ts';

const KINDS = ['productive', 'neutral', 'draining'];

const SYSTEM_PROMPT = `
You label time-tracking activities so a person's week can be summed up
honestly. For each activity you are given, choose exactly one kind:

- "productive" — moves the person towards something they want: work,
  study, exercise, building, deliberate practice, caring for people.
- "neutral" — necessary or restorative, but not progress in itself:
  sleep, meals, chores, commuting, admin, deliberate rest.
- "draining" — time the person would usually regret afterwards:
  doomscrolling, compulsive checking, aimless browsing.

Rules:
- Judge the activity, not the person. Rest is neutral, never draining.
- Anything genuinely ambiguous is "neutral". That is the honest answer
  when a name could mean either thing, and it is the safest default
  because it does not inflate or deflate their numbers.
- The reason is one short clause, under 12 words, addressed as "you".
- Use the exact activity names you were given, spelled identically.

Reply with JSON only, in this shape:
{"activities":[{"name":"...","kind":"productive","reason":"..."}]}
`.trim();

Deno.serve(async (req: Request) => {
  const early = preflight(req);
  if (early) return early;

  const key = groqKey();
  if (!key) return missingKey();

  const denied = await requireUser(req);
  if (denied) return denied;

  let payload: { activities?: unknown };
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Body must be JSON.' }, 400);
  }

  const names = Array.isArray(payload.activities)
    ? payload.activities
        .map((a) => (typeof a === 'string' ? a : (a as { name?: string })?.name))
        .filter((n): n is string => typeof n === 'string' && !!n.trim())
        .map((n) => n.trim())
    : [];

  if (!names.length) return json({ error: 'Send at least one activity name.' }, 400);
  // A person does not have hundreds of activities; a client sending them
  // is confused, and the prompt would cost real money.
  if (names.length > 60) return json({ error: 'Too many activities to classify at once.' }, 413);

  const result = await chat({
    key,
    jsonOnly: true,
    temperature: 0.2,          // labelling, not writing — repeatability matters more than variety
    maxTokens: 1200,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify({ activities: names }) },
    ],
  });

  if (!result.ok) return result.response;

  const raw = await textOf(result.res);
  if (!raw) return json({ error: 'Groq returned a reply that could not be read.' }, 502);

  let parsed: { activities?: unknown };
  try {
    // response_format should make fences impossible, but a model that
    // ignores it would otherwise take the whole feature down.
    parsed = JSON.parse(raw.replace(/^```(?:json)?|```$/g, '').trim());
  } catch {
    return json({ error: 'Groq returned something that was not JSON.', model: result.model }, 502);
  }

  /* Trust nothing that comes back. A hallucinated activity name would
     write a kind onto the wrong row, and a kind outside the three the
     app knows about would poison every split it is used in. */
  const wanted = new Map(names.map((n) => [n.toLowerCase(), n]));
  const seen = new Set<string>();
  const out: { name: string; kind: string; reason: string }[] = [];

  if (Array.isArray(parsed.activities)) {
    for (const row of parsed.activities) {
      const r = row as { name?: unknown; kind?: unknown; reason?: unknown };
      const name = typeof r.name === 'string' ? wanted.get(r.name.trim().toLowerCase()) : undefined;
      const kind = typeof r.kind === 'string' ? r.kind.trim().toLowerCase() : '';

      if (!name || seen.has(name)) continue;      // invented, or answered twice
      if (KINDS.indexOf(kind) === -1) continue;   // not one of ours

      seen.add(name);
      out.push({
        name,
        kind,
        reason: typeof r.reason === 'string' ? r.reason.trim().slice(0, 120) : '',
      });
    }
  }

  if (!out.length) {
    return json({ error: 'The model did not return any usable labels.', model: result.model }, 502);
  }

  /* Anything it skipped is reported rather than silently dropped — the
     app shows those as "not classified" instead of pretending. */
  const missing = names.filter((n) => !seen.has(n));

  return json({ activities: out, missing, model: result.model, note: result.note }, 200, {
    'X-Chrona-Model': result.model,
    'X-Chrona-Note': result.note ? encodeURIComponent(result.note) : '',
  });
});
