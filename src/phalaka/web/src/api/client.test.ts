import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { postAction, apiUrl } from './client';

// postAction carries the mutation-auth contract: the token rides in the
// `Authorization: Bearer` HEADER and NEVER in the query string (which the server
// rejects for mutations). These tests pin that contract so a refactor can't
// silently regress the secret back into the URL.

const TOKEN = 'secret-token';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn((_input: string | URL, _init?: RequestInit) =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'paused', id: 'myapp' }) } as Response),
  );
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('postAction', () => {
  it('POSTs to the action route with the token in the Authorization header', async () => {
    await postAction(TOKEN, 'myapp', 'pause');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/kshetras/myapp/actions/pause');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
  });

  it('never puts the token in the query string (unlike the GET client)', async () => {
    await postAction(TOKEN, 'myapp', 'resume');
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).not.toContain('token=');
    expect(String(url)).not.toContain('?');
    // Contrast: the read client DOES put the token in the query string.
    expect(apiUrl('/api/kshetras', TOKEN)).toContain('token=');
  });

  it('encodes the kshetra id and targets the right action path', async () => {
    await postAction(TOKEN, 'weird/id', 'pause');
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/kshetras/weird%2Fid/actions/pause');
  });

  it('returns the parsed action body', async () => {
    const res = await postAction(TOKEN, 'myapp', 'pause');
    expect(res).toEqual({ status: 'paused', id: 'myapp' });
  });

  it('throws on a non-2xx response (e.g. 401/403 from the auth gate)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403 } as Response);
    await expect(postAction(TOKEN, 'myapp', 'pause')).rejects.toThrow('HTTP 403');
  });
});
