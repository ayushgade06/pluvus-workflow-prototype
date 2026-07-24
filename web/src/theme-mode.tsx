// ---------------------------------------------------------------------------
// Theme mode (light / dark) — runtime toggle backed by CSS variables.
// ---------------------------------------------------------------------------
// The palettes live in index.css under [data-theme]. This provider just tracks
// the active mode, mirrors it to `document.documentElement[data-theme]`, and
// persists the choice. Default is dark. Components read `colors.*` from
// theme.ts (which resolve to the active CSS vars), so nothing else has to know
// the mode — only the toggle button consumes this hook.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type ThemeMode = "light" | "dark";

const STORAGE_KEY = "pluvus-theme";
const DEFAULT_MODE: ThemeMode = "dark";

function readInitial(): ThemeMode {
  if (typeof window === "undefined") return DEFAULT_MODE;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : DEFAULT_MODE;
}

interface ThemeCtx {
  mode: ThemeMode;
  toggle: () => void;
  setMode: (m: ThemeMode) => void;
}

const Ctx = createContext<ThemeCtx | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readInitial);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", mode);
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // Storage can throw in private mode; the attribute swap is what matters.
    }
  }, [mode]);

  const setMode = useCallback((m: ThemeMode) => setModeState(m), []);
  const toggle = useCallback(
    () => setModeState((m) => (m === "dark" ? "light" : "dark")),
    [],
  );

  const value = useMemo<ThemeCtx>(() => ({ mode, toggle, setMode }), [mode, toggle, setMode]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useThemeMode(): ThemeCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useThemeMode must be used within <ThemeProvider>");
  return ctx;
}
