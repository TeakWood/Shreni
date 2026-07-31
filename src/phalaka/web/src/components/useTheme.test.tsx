// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useTheme } from './useTheme';

// jsdom here runs without a real localStorage (it is flag-gated), so provide a
// tiny in-memory shim — the hook already tolerates its absence via try/catch,
// but these tests need to observe what it persisted.
function installStorage() {
  const store = new Map<string, string>();
  const mock = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
  vi.stubGlobal('localStorage', mock);
  return mock;
}

// Drives the hook through a tiny harness: the button label mirrors the hook's
// theme, so clicking it toggles and lets us assert the persisted + DOM effects.
function Harness() {
  const [theme, toggle] = useTheme();
  return (
    <button type="button" onClick={toggle}>
      {theme}
    </button>
  );
}

beforeEach(() => {
  installStorage();
  delete document.documentElement.dataset.theme;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useTheme', () => {
  it('defaults to dark and mirrors it onto <html> + localStorage', () => {
    render(<Harness />);
    expect(screen.getByRole('button').textContent).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('phalaka-theme')).toBe('dark');
  });

  it('toggles to light and persists the choice', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('button').textContent).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('phalaka-theme')).toBe('light');
  });

  it('restores a persisted light choice on mount (survives reload)', () => {
    localStorage.setItem('phalaka-theme', 'light');
    render(<Harness />);
    expect(screen.getByRole('button').textContent).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
