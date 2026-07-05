import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { basename, resolve } from 'path';

const mockInitKshetra = vi.fn<(opts: unknown) => Promise<void>>();
vi.mock('./init-kshetra.js', () => ({ initKshetra: mockInitKshetra }));

const { runInit } = await import('./init.js');

// Keep TTY off so tests are deterministic (no readline prompt).
let ttyDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  mockInitKshetra.mockReset();
  mockInitKshetra.mockResolvedValue(undefined);
  ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
});

afterEach(() => {
  if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
  vi.restoreAllMocks();
});

describe('runInit (wrapper)', () => {
  it('passes explicit slug/path (resolved) and all options through to initKshetra', async () => {
    await runInit({
      slug: 'myapp',
      path: '/tmp/myapp',
      org: 'Acme',
      language: 'python',
      beadsPath: '/tmp/myapp-beads',
      provider: 'claude',
      model: 'claude-opus-4-8',
      mergePolicy: 'pr',
      dryRun: true,
    });
    expect(mockInitKshetra).toHaveBeenCalledTimes(1);
    expect(mockInitKshetra).toHaveBeenCalledWith({
      slug: 'myapp',
      path: resolve('/tmp/myapp'),
      org: 'Acme',
      language: 'python',
      beadsPath: '/tmp/myapp-beads',
      provider: 'claude',
      model: 'claude-opus-4-8',
      mergePolicy: 'pr',
      dryRun: true,
    });
  });

  it('non-interactively defaults slug to the basename of an explicit path', async () => {
    await runInit({ path: '/tmp/some-repo' });
    const arg = mockInitKshetra.mock.calls[0][0] as { slug: string; path: string };
    expect(arg.slug).toBe('some-repo');
    expect(arg.path).toBe(resolve('/tmp/some-repo'));
  });

  it('non-interactively defaults path to cwd and slug to its basename when nothing is given', async () => {
    await runInit({});
    const arg = mockInitKshetra.mock.calls[0][0] as { slug: string; path: string };
    expect(arg.path).toBe(process.cwd());
    expect(arg.slug).toBe(basename(process.cwd()));
  });
});