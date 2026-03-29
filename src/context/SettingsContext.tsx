import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

const KEY = "kakeibo_font_scale";

type Settings = {
  fontScale: number;
  setFontScale: (n: number) => void;
};

const SettingsContext = createContext<Settings | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [fontScale, setFontScaleState] = useState(() => {
    try {
      const v = Number.parseFloat(localStorage.getItem(KEY) || "1");
      return Number.isFinite(v) && v >= 0.85 && v <= 1.35 ? v : 1;
    } catch {
      return 1;
    }
  });

  useEffect(() => {
    document.documentElement.style.setProperty(
      "--app-font-scale",
      String(fontScale),
    );
    try {
      localStorage.setItem(KEY, String(fontScale));
    } catch {
      /* ignore */
    }
  }, [fontScale]);

  const setFontScale = (n: number) => {
    const clamped = Math.min(1.35, Math.max(0.85, n));
    setFontScaleState(clamped);
  };

  const value = useMemo(
    () => ({ fontScale, setFontScale }),
    [fontScale, setFontScale],
  );

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings outside SettingsProvider");
  return ctx;
}
