import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

const KEY = "kakeibo_font_scale";
const MODE_KEY = "kakeibo_font_mode";
const THEME_KEY = "kakeibo_theme_mode";

type FontMode = "standard" | "large" | "xlarge";
type ThemeMode = "light" | "dark";
const FONT_MODE_SCALE: Record<FontMode, number> = {
  standard: 1.06,
  large: 1.18,
  xlarge: 1.3,
};

type Settings = {
  fontScale: number;
  fontMode: FontMode;
  themeMode: ThemeMode;
  setFontScale: (n: number) => void;
  setFontMode: (m: FontMode) => void;
  setThemeMode: (m: ThemeMode) => void;
};

const SettingsContext = createContext<Settings | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [themeMode, setThemeModeState] = useState<ThemeMode>(() => {
    try {
      const raw = localStorage.getItem(THEME_KEY);
      return raw === "light" || raw === "dark" ? raw : "light";
    } catch {
      return "light";
    }
  });

  const [fontMode, setFontModeState] = useState<FontMode>(() => {
    try {
      const raw = localStorage.getItem(MODE_KEY);
      return raw === "standard" || raw === "large" || raw === "xlarge"
        ? raw
        : "large";
    } catch {
      return "large";
    }
  });

  const [fontScale, setFontScaleState] = useState(() => {
    try {
      const fallback = FONT_MODE_SCALE[fontMode];
      const v = Number.parseFloat(localStorage.getItem(KEY) || String(fallback));
      return Number.isFinite(v) && v >= 0.85 && v <= 1.4 ? v : fallback;
    } catch {
      return FONT_MODE_SCALE[fontMode];
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

  useEffect(() => {
    try {
      localStorage.setItem(MODE_KEY, fontMode);
    } catch {
      /* ignore */
    }
  }, [fontMode]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", themeMode);
    try {
      localStorage.setItem(THEME_KEY, themeMode);
    } catch {
      /* ignore */
    }
  }, [themeMode]);

  const setFontScale = (n: number) => {
    const clamped = Math.min(1.4, Math.max(0.85, n));
    setFontScaleState(clamped);
    if (Math.abs(clamped - FONT_MODE_SCALE.standard) < 0.03) {
      setFontModeState("standard");
    } else if (Math.abs(clamped - FONT_MODE_SCALE.large) < 0.03) {
      setFontModeState("large");
    } else if (Math.abs(clamped - FONT_MODE_SCALE.xlarge) < 0.03) {
      setFontModeState("xlarge");
    }
  };

  const setFontMode = (m: FontMode) => {
    setFontModeState(m);
    setFontScaleState(FONT_MODE_SCALE[m]);
  };

  const setThemeMode = (m: ThemeMode) => {
    setThemeModeState(m);
  };

  const value = useMemo(
    () => ({ fontScale, fontMode, themeMode, setFontScale, setFontMode, setThemeMode }),
    [fontScale, fontMode, themeMode],
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
