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

type FontMode = "small" | "standard" | "large";
export type FixedCostItem = {
  id: string;
  amount: number;
  category: string;
};
const THEME_MODES = ["light", "dark", "paper", "ocean"] as const;
type ThemeMode = (typeof THEME_MODES)[number];

function parseThemeMode(raw: string | null): ThemeMode {
  return THEME_MODES.includes(raw as ThemeMode) ? (raw as ThemeMode) : "light";
}

function currentYm() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function isFutureYm(ym: string) {
  if (!/^\d{4}-\d{2}$/.test(ym)) return false;
  return ym > currentYm();
}

function ymToNumber(ym: string) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return null;
  return Number(m[1]) * 100 + Number(m[2]);
}

export function getEffectiveFixedCostsForMonth(
  fixedCostsByMonth: Record<string, FixedCostItem[]>,
  ym: string,
) {
  const target = ymToNumber(ym);
  if (target == null) return [];
  let hitYm = "";
  let hitNum = -1;
  for (const key of Object.keys(fixedCostsByMonth)) {
    const n = ymToNumber(key);
    if (n == null) continue;
    if (n <= target && n > hitNum) {
      hitNum = n;
      hitYm = key;
    }
  }
  return hitYm ? fixedCostsByMonth[hitYm] ?? [] : [];
}

const FONT_MODE_SCALE: Record<FontMode, number> = {
  small: 0.92,
  standard: 1,
  large: 1.12,
};

type Settings = {
  fontScale: number;
  fontMode: FontMode;
  themeMode: ThemeMode;
  fixedCostsByMonth: Record<string, FixedCostItem[]>;
  setFontScale: (n: number) => void;
  setFontMode: (m: FontMode) => void;
  setThemeMode: (m: ThemeMode) => void;
  setFixedCostsForMonth: (ym: string, items: FixedCostItem[]) => void;
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
      return raw === "small" || raw === "standard" || raw === "large"
        ? raw
        : "standard";
    } catch {
      return "standard";
    }
  });

  const [fontScale, setFontScaleState] = useState(() => {
    try {
      const fallback = FONT_MODE_SCALE[fontMode];
      const v = Number.parseFloat(localStorage.getItem(KEY) || String(fallback));
      return Number.isFinite(v) && v >= 0.85 && v <= 1.2 ? v : fallback;
    } catch {
      return FONT_MODE_SCALE[fontMode];
    }
  });
  const [fixedCostsByMonth, setFixedCostsByMonth] = useState<Record<string, FixedCostItem[]>>(() => {
    try {
      const raw = localStorage.getItem(FIXED_COSTS_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      if (!parsed || typeof parsed !== "object") return {};
      const out: Record<string, FixedCostItem[]> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (!/^\d{4}-\d{2}$/.test(k)) continue;
        if (Array.isArray(v)) {
          const items: FixedCostItem[] = [];
          for (const x of v) {
            if (!x || typeof x !== "object") continue;
            const amt = Number((x as { amount?: unknown }).amount);
            if (!Number.isFinite(amt) || amt < 0) continue;
            const id = String((x as { id?: unknown }).id ?? `fixed-${items.length + 1}`);
            const legacyNote = String((x as { note?: unknown }).note ?? "");
            const category = String((x as { category?: unknown }).category ?? legacyNote)
              .trim()
              .slice(0, 40);
            items.push({ id, amount: Math.round(amt), category });
          }
          if (items.length > 0) out[k] = items;
          continue;
        }
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) {
          out[k] = [{ id: "legacy-1", amount: Math.round(n), category: "固定費" }];
        }
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
    const clamped = Math.min(1.2, Math.max(0.85, n));
    setFontScaleState(clamped);
    if (Math.abs(clamped - FONT_MODE_SCALE.small) < 0.03) {
      setFontModeState("small");
    } else if (Math.abs(clamped - FONT_MODE_SCALE.standard) < 0.03) {
      setFontModeState("standard");
    } else if (Math.abs(clamped - FONT_MODE_SCALE.large) < 0.03) {
      setFontModeState("large");
    }
  };

  const setFontMode = (m: FontMode) => {
    setFontModeState(m);
    setFontScaleState(FONT_MODE_SCALE[m]);
  };

  const setThemeMode = (m: ThemeMode) => {
    setThemeModeState(m);
  };

  const setFixedCostsForMonth = (ym: string, items: FixedCostItem[]) => {
    if (!/^\d{4}-\d{2}$/.test(ym)) return;
    if (!isFutureYm(ym)) return;
    const cleaned = (Array.isArray(items) ? items : [])
      .map((x, i) => ({
        id: String(x?.id ?? `fixed-${i + 1}`),
        amount: Math.max(0, Math.round(Number(x?.amount ?? 0))),
        category: String(x?.category ?? "").trim().slice(0, 40),
      }))
      .filter((x) => Number.isFinite(x.amount) && x.amount > 0);
    setFixedCostsByMonth((prev) => {
      const next = { ...prev };
      if (cleaned.length === 0) {
        delete next[ym];
      } else {
        next[ym] = cleaned;
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
      setFixedCostsForMonth,
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
