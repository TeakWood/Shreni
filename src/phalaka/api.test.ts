import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';

// ── module mocks ─────────────────────────────────────────────────────────────
// requireMutationAuth reads the shared secret via readToken(); everything else in
// api.ts is untouched by these tests, so only token.js is mocked.

const mockReadToken = vi.fn<() => string | null>();
vi.mock('./token.js', () => ({ readToken: mockReadToken }));

const { requireMutationAuth } = await import('./api.js');

// ── fixtures / helpers ────────────────────────────────────────────────────────

const TOKEN = 'secret-token';
const LOOPBACK_HOST = '127.0.0.1:7348';
const LOOPBACK_ORIGIN = 'http://127.0.0.1:7348';

function makeReq(opts: {
  bearer?: string;
  queryToken?: string;
  host?: string | undefined;
  origin?: string;
}): FastifyRequest {
  const headers: Record<string, string> = {};
  if (opts.bearer !== undefined) headers['authorization'] = `Bearer ${opts.bearer}`;
  if (opts.host !== undefined) headers['host'] = opts.host;
  if (opts.origin !== undefined) headers['origin'] = opts.origin;
  const query = opts.queryToken !== undefined ? { token: opts.queryToken } : {};
  return { headers, query } as unknown as FastifyRequest;
}

interface CapturedReply {
  reply: FastifyReply;
  statusCode: number | undefined;
  payload: unknown;
}

function makeReply(): CapturedReply {
  const captured: CapturedReply = { reply: undefined as unknown as FastifyReply, statusCode: undefined, payload: undefined };
  const reply = {
    code(c: number) {
      captured.statusCode = c;
      return reply;
    },
    send(p: unknown) {
      captured.payload = p;
      return reply;
    },
  };
  captured.reply = reply as unknown as FastifyReply;
  return captured;
}

// Run the helper and return { ok, status } for terse matrix assertions.
function run(reqOpts: Parameters<typeof makeReq>[0]): { ok: boolean; status: number | undefined } {
  const cap = makeReply();
  const ok = requireMutationAuth(makeReq(reqOpts), cap.reply);
  return { ok, status: cap.statusCode };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockReadToken.mockReturnValue(TOKEN);
});

// ── the token × origin/host matrix ──────────────────────────────────────────

describe('requireMutationAuth — token carrier', () => {
  it('200: header-Bearer token on a loopback host', () => {
    expect(run({ bearer: TOKEN, host: LOOPBACK_HOST })).toEqual({ ok: true, status: undefined });
  });

  it('401: query-string token is rejected for mutations (even when correct)', () => {
    // The whole point of the stricter gate — the query token GET accepts must NOT
    // authorize a mutation, keeping the destructive secret out of URLs/history.
    expect(run({ queryToken: TOKEN, host: LOOPBACK_HOST })).toEqual({ ok: false, status: 401 });
  });

  it('401: no token at all', () => {
    expect(run({ host: LOOPBACK_HOST })).toEqual({ ok: false, status: 401 });
  });

  it('401: a wrong Bearer token', () => {
    expect(run({ bearer: 'nope', host: LOOPBACK_HOST })).toEqual({ ok: false, status: 401 });
  });

  it('401: an empty Bearer token', () => {
    const cap = makeReply();
    const req = { headers: { authorization: 'Bearer ', host: LOOPBACK_HOST }, query: {} } as unknown as FastifyRequest;
    expect(requireMutationAuth(req, cap.reply)).toBe(false);
    expect(cap.statusCode).toBe(401);
  });

  it('401: no token configured on disk (readToken null) — never authorizes', () => {
    mockReadToken.mockReturnValue(null);
    expect(run({ bearer: TOKEN, host: LOOPBACK_HOST })).toEqual({ ok: false, status: 401 });
  });
});

describe('requireMutationAuth — Origin/Host loopback guard', () => {
  it('200: loopback Origin + loopback Host with a header token', () => {
    expect(run({ bearer: TOKEN, host: LOOPBACK_HOST, origin: LOOPBACK_ORIGIN })).toEqual({ ok: true, status: undefined });
  });

  it('200: localhost Origin/Host is loopback too', () => {
    expect(run({ bearer: TOKEN, host: 'localhost:7348', origin: 'http://localhost:7348' })).toEqual({ ok: true, status: undefined });
  });

  it('200: absent Origin is allowed (same-origin/navigation requests omit it)', () => {
    expect(run({ bearer: TOKEN, host: LOOPBACK_HOST })).toEqual({ ok: true, status: undefined });
  });

  it('403: a foreign Origin (DNS-rebinding) is rejected even with a valid token', () => {
    expect(run({ bearer: TOKEN, host: LOOPBACK_HOST, origin: 'http://evil.com' })).toEqual({ ok: false, status: 403 });
  });

  it('403: the opaque "null" Origin is treated as non-loopback', () => {
    expect(run({ bearer: TOKEN, host: LOOPBACK_HOST, origin: 'null' })).toEqual({ ok: false, status: 403 });
  });

  it('403: a foreign Host is rejected', () => {
    expect(run({ bearer: TOKEN, host: 'evil.com' })).toEqual({ ok: false, status: 403 });
  });

  it('403: a missing Host header is rejected', () => {
    expect(run({ bearer: TOKEN, host: undefined })).toEqual({ ok: false, status: 403 });
  });

  it('403: Origin/Host guard fires BEFORE the token check (foreign origin + no token → 403)', () => {
    // Precedence: a foreign-origin request is refused without the secret ever
    // being validated, so a missing token still yields 403, not 401.
    expect(run({ host: LOOPBACK_HOST, origin: 'http://evil.com' })).toEqual({ ok: false, status: 403 });
  });

  it('200: a bare 127.0.0.1 Host (no port) is loopback', () => {
    expect(run({ bearer: TOKEN, host: '127.0.0.1' })).toEqual({ ok: true, status: undefined });
  });

  it('403: a look-alike host (127.0.0.1.evil.com) is NOT loopback', () => {
    expect(run({ bearer: TOKEN, host: '127.0.0.1.evil.com' })).toEqual({ ok: false, status: 403 });
  });
});
