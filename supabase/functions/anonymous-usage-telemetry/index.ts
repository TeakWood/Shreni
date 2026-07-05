// Shreni telemetry ingest (yds.5 / Shreni-beads-60f).
//
// A PUBLIC Supabase Edge Function that accepts the anonymous, opt-in events the
// Shreni CLI posts (see src/telemetry/telemetry.ts). It runs with the service
// role server-side, so no DB credential ships in the npm package, and it is the
// single sanctioned write path to public.events.
//
// Privacy invariants (must hold — the CLI's consent copy promises them):
//   • NEVER read or store the client IP or any request header identity.
//   • Only insert the allowlisted, non-identifying fields below; drop everything
//     else (including the client-supplied timestamp — we use server receipt time).
//
// Deploy:  supabase functions deploy anonymous-usage-telemetry --no-verify-jwt
//   (--no-verify-jwt because the CLI posts a bare body with no auth header.)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// The only event names we accept. Anything else is dropped — a public endpoint
// receives garbage and abuse, so validate strictly.
const ALLOWED_EVENTS = new Set(['session_start', 'kshetra_init', 'task_merged']);
// Only these two are stored; anything else (or missing) is coerced to 'production'
// so a public caller can never mislabel real traffic as test — or invent values.
const ALLOWED_ENVIRONMENTS = new Set(['test', 'production']);

const MAX_BODY_BYTES = 4 * 1024; // events are tiny; reject anything larger
const MAX_STR = 64; // cap version/platform/prop string lengths
const MAX_PROP_KEYS = 12;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface EventRow {
  name: string;
  anonymous_id: string;
  version: string | null;
  platform: string | null;
  environment: string;
  props: Record<string, string | number | boolean> | null;
}

function clampStr(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, MAX_STR) : null;
}

// Keep only primitive prop values, cap count + string sizes, drop the rest.
function sanitizeProps(raw: unknown): Record<string, string | number | boolean> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, string | number | boolean> = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= MAX_PROP_KEYS) break;
    if (typeof v === 'string') out[k.slice(0, MAX_STR)] = v.slice(0, MAX_STR);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k.slice(0, MAX_STR)] = v;
    else if (typeof v === 'boolean') out[k.slice(0, MAX_STR)] = v;
    else continue;
    n++;
  }
  return n > 0 ? out : null;
}

// Turn an untrusted body into a safe row, or null if it isn't a valid event.
// Deliberately maps ONLY the allowlisted fields — the client's `ts` is ignored
// (server receipt time is the truth) and no header/IP is ever consulted.
export function sanitizeEvent(raw: unknown): EventRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  const name = typeof e.name === 'string' ? e.name : '';
  if (!ALLOWED_EVENTS.has(name)) return null;
  const anonymousId = typeof e.anonymousId === 'string' ? e.anonymousId : '';
  if (!UUID_RE.test(anonymousId)) return null;
  const environment =
    typeof e.environment === 'string' && ALLOWED_ENVIRONMENTS.has(e.environment)
      ? e.environment
      : 'production';
  return {
    name,
    anonymous_id: anonymousId,
    version: clampStr(e.version),
    platform: clampStr(e.platform),
    environment,
    props: sanitizeProps(e.props),
  };
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  // Size guard before parsing.
  const body = await req.text();
  if (body.length > MAX_BODY_BYTES) return new Response('payload too large', { status: 413 });

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return new Response('bad json', { status: 400 });
  }

  const row = sanitizeEvent(parsed);
  if (!row) return new Response('rejected', { status: 400 });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const { error } = await supabase.from('events').insert(row);
  if (error) {
    // Don't leak details to an anonymous caller; log server-side.
    console.error('insert failed:', error.message);
    return new Response('error', { status: 500 });
  }

  // No body — the caller is a fire-and-forget CLI that ignores the response.
  return new Response(null, { status: 204 });
});