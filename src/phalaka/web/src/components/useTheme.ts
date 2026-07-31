import { useCallback, useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'phalaka-theme';

function initialTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

// Header light/dark toggle. Dark is the default; the choice persists in
// localStorage and is mirrored onto <html data-theme> so the `light:` Tailwind
// variant (and the --bg/--fg vars) switch. The head script in index.html applies
// the stored theme before paint; this hook keeps it in sync as the user toggles.
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* ignore persistence failures (private mode, storage disabled) */
    }
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme(t => (t === 'dark' ? 'light' : 'dark'));
  }, []);

  return [theme, toggle];
}
