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
const FIXED_COSTS_KEY = "kakeibo_fixed_costs_by_month";

type FontMode = "small" | "standard" | "large" | "xlarge";
const THEME_MODES = ["light", "dark", "paper", "ocean"] as const;
type ThemeMode = (typeof THEME_MODES)[number];

function parseThemeMode(raw: string | null): ThemeMode {
  return THEME_MODES.includes(raw as ThemeMode) ? (raw as ThemeMode) : "light";
}
const FONT_MODE_SCALE: Record<FontMode, number> = {
  small: 0.94,
  standard: 1.06,
  large: 1.18,
  xlarge: 1.3,
};

type Settings = {
  fontScale: number;
  fontMode: FontMode;
  themeMode: ThemeMode;
  fixedCostsByMonth: Record<string, number>;
  setFontScale: (n: number) => void;
  setFontMode: (m: FontMode) => void;
  setThemeMode: (m: ThemeMode) => void;
  setFixedCostForMonth: (ym: string, amount: number) => void;
};

const SettingsContext = createContext<Settings | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [themeMode, setThemeModeState] = useState<ThemeMode>(() => {
    try {
      return parseThemeMode(localStorage.getItem(THEME_KEY));
    } catch {
      return "light";
    }
  });

  const [fontMode, setFontModeState] = useState<FontMode>(() => {
    try {
      const raw = localStorage.getItem(MODE_KEY);
      return raw === "small" || raw === "standard" || raw === "large" || raw === "xlarge"
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
  const [fixedCostsByMonth, setFixedCostsByMonth] = useState<Record<string, number>>(() => {
    try {
      const raw = localStorage.getItem(FIXED_COSTS_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      if (!parsed || typeof parsed !== "object") return {};
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (!/^\d{4}-\d{2}$/.test(k)) continue;
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0) out[k] = Math.round(n);
      }
      return out;
    } catch {
      return {};
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

  useEffect(() => {
    try {
      localStorage.setItem(FIXED_COSTS_KEY, JSON.stringify(fixedCostsByMonth));
    } catch {
      /* ignore */
    }
  }, [fixedCostsByMonth]);

  const setFontScale = (n: number) => {
    const clamped = Math.min(1.4, Math.max(0.85, n));
    setFontScaleState(clamped);
    if (Math.abs(clamped - FONT_MODE_SCALE.small) < 0.03) {
      setFontModeState("small");
    } else if (Math.abs(clamped - FONT_MODE_SCALE.standard) < 0.03) {
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

  const setFixedCostForMonth = (ym: string, amount: number) => {
    if (!/^\d{4}-\d{2}$/.test(ym)) return;
    const n = Math.max(0, Math.round(Number.isFinite(amount) ? amount : 0));
    setFixedCostsByMonth((prev) => {
      const next = { ...prev };
      if (n <= 0) {
        delete next[ym];
      } else {
        next[ym] = n;
      }
      return next;
    });
  };

  const value = useMemo(
    () => ({
      fontScale,
      fontMode,
      themeMode,
      fixedCostsByMonth,
      setFontScale,
      setFontMode,
      setThemeMode,
      setFixedCostForMonth,
    }),
    [fontScale, fontMode, themeMode, fixedCostsByMonth],
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
