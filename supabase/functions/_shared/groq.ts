/* ═══════════════════════════════════════════════════════════════
   _shared/groq.ts — the parts every Chrona function needs

   Auth, CORS, and one Groq call that survives a retired model. Folders
   starting with `_` are not functions and are skipped by the deploy
   workflow; this is imported by the ones that are.
   ═══════════════════════════════════════════════════════════════ */

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODELS_URL = 'https://api.groq.com/openai/v1/models';

/* Groq retires models on a schedule. llama-3.3-70b-versatile was the
   default until it was decommissioned on 2026-08-16, and every function
   using it broke at once — Groq answers a retired name with a 404, which
   reads as "this feature is broken" rather than "that model is gone".

   So the name is a starting guess, not a dependency: if it is refused,
   the account is asked what it can actually serve. Pin one to skip that:
     supabase secrets set GROQ_MODEL=... */
const DEFAULT_MODEL = 'openai/gpt-oss-120b';

const FALLBACK_ORDER = [
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'groq/compound',
  'groq/compound-mini',
];

/* The model list also carries speech, embedding and moderation models —
   none of which can answer a chat completion. */
const NOT_CHAT = /whisper|tts|embed|guard|moderation/i;

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Expose-Headers': 'X-Chrona-Model, X-Chrona-Note',
};

export function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', ...extra },
  });
}

export function preflight(req: Request): Response | null {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);
  return null;
}

export function groqKey(): string | null {
  return Deno.env.get('GROQ_API_KEY') ?? null;
}

export function missingKey() {
  return json({
    error: 'GROQ_API_KEY is not set on this function. Run: supabase secrets set GROQ_API_KEY=gsk_...',
  }, 500);
}

/* Require a signed-in Supabase user. Without this a function is an open
   relay: anyone who finds the URL spends the account's Groq credit. */
export async function requireUser(req: Request): Promise<Response | null> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'Sign in first.' }, 401);

  const url = Deno.env.get('SUPABASE_URL');
  const anon = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !anon) return json({ error: 'Function is missing SUPABASE_URL / SUPABASE_ANON_KEY.' }, 500);

  const res = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: anon, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return json({ error: 'That session is not valid. Sign in again.' }, 401);
  return null;
}

/* Groq's own message is worth keeping — "model not found" and "invalid
   key" are the two failures you want to read verbatim. */
export function groqDetail(raw: string) {
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    return parsed?.error?.message ?? raw.slice(0, 400);
  } catch { return raw.slice(0, 400); }
}

/* A retired model and a bad key both fail the request, but only the first
   is worth retrying — so match on what Groq says, not on status alone.
   Retrying a bad key would spend two requests to fail twice. */
function modelIsGone(status: number, detail: string) {
  return status === 404 || /does not exist|decommissioned|deprecat|no longer/i.test(detail);
}

/* Ask the account what it can actually serve. Returns null on any trouble:
   a failed lookup must not replace Groq's original error, which is more
   useful than anything this could say instead. */
async function resolveModel(key: string, exclude: string): Promise<string | null> {
  let ids: string[] = [];
  try {
    const res = await fetch(MODELS_URL, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) return null;
    const data = (JSON.parse(await res.text()) as { data?: { id?: string }[] })?.data;
    if (!Array.isArray(data)) return null;
    ids = data.map((m) => m?.id).filter((id): id is string => !!id);
  } catch { return null; }

  const chat = ids.filter((id) => !NOT_CHAT.test(id) && id !== exclude);
  return FALLBACK_ORDER.find((want) => chat.includes(want)) ?? chat[0] ?? null;
}

export interface Msg { role: 'system' | 'user'; content: string; }

export interface ChatOpts {
  key: string;
  messages: Msg[];
  stream?: boolean;
  temperature?: number;
  maxTokens?: number;
  jsonOnly?: boolean;
}

export type ChatResult =
  | { ok: true; res: Response; model: string; note: string | null }
  | { ok: false; response: Response };

function call(o: ChatOpts, model: string) {
  const body: Record<string, unknown> = {
    model,
    stream: !!o.stream,
    temperature: o.temperature ?? 0.4,
    max_tokens: o.maxTokens ?? 900,
    messages: o.messages,
  };
  // Asking for JSON is what stops a model wrapping its answer in prose or
  // a code fence, which would then have to be guessed back out of it.
  if (o.jsonOnly) body.response_format = { type: 'json_object' };

  return fetch(GROQ_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${o.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/* One completion, retried once against a model the account can serve if
   the configured one turns out to be gone. The body is never read here:
   on the streaming path it has to reach the browser unbuffered, and
   reading it to look for an error would consume it. Errors arrive as a
   non-OK status before any tokens flow, so res.ok is enough. */
export async function chat(o: ChatOpts): Promise<ChatResult> {
  let model = Deno.env.get('GROQ_MODEL') ?? DEFAULT_MODEL;
  let note: string | null = null;

  let res: Response;
  try {
    res = await call(o, model);
  } catch (e) {
    return { ok: false, response: json({ error: 'Could not reach Groq: ' + (e as Error).message }, 502) };
  }

  if (!res.ok) {
    const raw = await res.text();
    const detail = groqDetail(raw);

    if (modelIsGone(res.status, detail)) {
      const alt = await resolveModel(o.key, model);
      if (alt) {
        try {
          res = await call(o, alt);
          note = `${model} is no longer available on this account, so ${alt} was used instead. Set GROQ_MODEL to choose deliberately.`;
          model = alt;
        } catch (e) {
          return { ok: false, response: json({ error: 'Could not reach Groq: ' + (e as Error).message }, 502) };
        }
      }
    }

    if (!res.ok) {
      const finalRaw = res.bodyUsed ? raw : await res.text();
      return {
        ok: false,
        response: json({ error: `Groq returned ${res.status}: ${groqDetail(finalRaw)}`, model }, 502),
      };
    }
  }

  return { ok: true, res, model, note };
}

/* Pull the assistant's message out of a completed (non-streaming) reply. */
export async function textOf(res: Response): Promise<string | null> {
  try {
    const data = JSON.parse(await res.text()) as {
      choices?: { message?: { content?: string } }[];
    };
    return data?.choices?.[0]?.message?.content ?? null;
  } catch { return null; }
}
