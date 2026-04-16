import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "./AuthContext";
import { hasPremiumNavAccess } from "../lib/subscriptionAccess";
import {
  canSendAuthenticatedRequest,
  getApiBaseUrl,
  getFamilyFixedCosts,
  putFamilyFixedCosts,
} from "../lib/api";
import {
  NAV_SKIN_TIER_CATALOG,
  type NavIconPaths,
  buildNavIconPaths,
  isKnownNavSkinId,
  isPremiumVariantSkinId,
  DEFAULT_NAV_SKIN_ID,
  PREMIUM_NAV_SKIN_ID,
  PREMIUM_VARIANT_SKIN_IDS,
} from "../config/navSkins";

const KEY = "kakeibo_font_scale";
const MODE_KEY = "kakeibo_font_mode";
const THEME_KEY = "kakeibo_theme_mode";
const FIXED_COSTS_KEY = "kakeibo_fixed_costs_by_month";
const GLOBAL_FIXED_COSTS_KEY = "__all__";
const NAV_SKIN_KEY = "kakeibo_nav_skin_id";
const OWNED_NAV_SKINS_KEY = "kakeibo_owned_nav_skins";
const NAV_ICON_FILE_KEYS: Array<keyof NavIconPaths> = [
  "dashboard",
  "kakeibo",
  "csvPc",
  "receipt",
  "settings",
  "admin",
];

function readOwnedNavSkinIds(): string[] {
  try {
    const raw = localStorage.getItem(OWNED_NAV_SKINS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string" && x.length > 0);
  } catch {
    return [];
  }
}

function readPersistedNavSkinId(): string {
  try {
    const raw = localStorage.getItem(NAV_SKIN_KEY);
    return raw && isKnownNavSkinId(raw) ? raw : DEFAULT_NAV_SKIN_ID;
  } catch {
    return DEFAULT_NAV_SKIN_ID;
  }
}

function readLegacyFixedCostsFromLocalStorage(): FixedCostItem[] {
  try {
    const raw = localStorage.getItem(FIXED_COSTS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object") return [];
    const globalItems = (parsed as Record<string, unknown>)[GLOBAL_FIXED_COSTS_KEY];
    const source = Array.isArray(globalItems)
      ? globalItems
      : Object.values(parsed).find((v) => Array.isArray(v));
    if (!Array.isArray(source)) return [];
    const out: FixedCostItem[] = [];
    for (const x of source) {
      if (!x || typeof x !== "object") continue;
      const amt = Number((x as { amount?: unknown }).amount);
      if (!Number.isFinite(amt) || amt <= 0) continue;
      const id = String((x as { id?: unknown }).id ?? `fixed-${out.length + 1}`);
      const legacyNote = String((x as { note?: unknown }).note ?? "");
      const category = String((x as { category?: unknown }).category ?? legacyNote)
        .trim()
        .slice(0, 40);
      if (!category) continue;
      out.push({ id, amount: Math.round(amt), category });
    }
    return out;
  } catch {
    return [];
  }
}

function legacyFixedCostsRecord(): Record<string, FixedCostItem[]> {
  const legacy = readLegacyFixedCostsFromLocalStorage();
  return legacy.length > 0 ? { [GLOBAL_FIXED_COSTS_KEY]: legacy } : {};
}

function serverFixedCostsToItems(
  rows: Array<{ id: number; category: string; amount: unknown }>,
): FixedCostItem[] {
  return rows.map((row) => ({
    id: `srv-${row.id}`,
    amount: Math.max(0, Math.round(Number(row.amount ?? 0))),
    category: String(row.category ?? "")
      .trim()
      .slice(0, 40),
  }));
}

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

function ymToNumber(ym: string) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return null;
  return Number(m[1]) * 100 + Number(m[2]);
}

export function getEffectiveFixedCostsForMonth(
  fixedCostsByMonth: Record<string, FixedCostItem[]>,
  ym: string,
) {
  const globalItems = fixedCostsByMonth[GLOBAL_FIXED_COSTS_KEY];
  if (Array.isArray(globalItems) && globalItems.length > 0) {
    return globalItems;
  }
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

export type NavSkinOptionView = {
  id: string;
  label: string;
  description?: string;
  unlocked: boolean;
  selected: boolean;
};

type Settings = {
  fontScale: number;
  fontMode: FontMode;
  themeMode: ThemeMode;
  fixedCostsByMonth: Record<string, FixedCostItem[]>;
  /** 実際に表示に使うナビアイコン（未購入スキンは既定へフォールバック済み） */
  navSkinId: string;
  navIconPaths: NavIconPaths;
  navSkinOptions: NavSkinOptionView[];
  /** Tmp02〜（アセットがあるフォルダのみ）。プレミアム会員向けサブ選択 */
  navPremiumVariantOptions: NavSkinOptionView[];
  /** 存在確認済みのスキンID（Tmp04 追加時も自動で候補に入る） */
  availableNavSkinIds: string[];
  /** Stripe サブスク等でプレミアムナビスキンが選べるか */
  premiumNavUnlocked: boolean;
  setFontScale: (n: number) => void;
  setFontMode: (m: FontMode) => void;
  setThemeMode: (m: ThemeMode) => void;
  setFixedCostsForMonth: (ym: string, items: FixedCostItem[]) => Promise<void>;
  /** 未購入スキンは false。成功時のみ true */
  setNavSkinId: (id: string) => boolean;
  /** 決済・サーバ同期後に購入済み ID をマージ（localStorage にも保存） */
  mergeOwnedNavSkinsFromServer: (ids: readonly string[]) => void;
};

const SettingsContext = createContext<Settings | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const { token, user: authUser } = useAuth();
  const apiBase = getApiBaseUrl();
  const premiumNavUnlocked = hasPremiumNavAccess(authUser);

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
  const [ownedNavSkinIds, setOwnedNavSkinIds] = useState<string[]>(() => readOwnedNavSkinIds());
  const [availableNavSkinIds, setAvailableNavSkinIds] = useState<string[]>([DEFAULT_NAV_SKIN_ID]);
  const [navSkinAssetsChecked, setNavSkinAssetsChecked] = useState(false);

  const [navSkinId, setNavSkinIdState] = useState<string>(() => {
    const raw = readPersistedNavSkinId();
    return isKnownNavSkinId(raw) ? raw : DEFAULT_NAV_SKIN_ID;
  });

  const [fixedCostsByMonth, setFixedCostsByMonth] = useState<
    Record<string, FixedCostItem[]>
  >({});

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
      localStorage.setItem(OWNED_NAV_SKINS_KEY, JSON.stringify(ownedNavSkinIds));
    } catch {
      /* ignore */
    }
  }, [ownedNavSkinIds]);

  useEffect(() => {
    try {
      localStorage.setItem(NAV_SKIN_KEY, navSkinId);
    } catch {
      /* ignore */
    }
  }, [navSkinId]);

  useEffect(() => {
    let cancelled = false;
    const candidates = [DEFAULT_NAV_SKIN_ID, ...PREMIUM_VARIANT_SKIN_IDS];
    const checkSkinAssets = async (skinId: string): Promise<boolean> => {
      const paths = buildNavIconPaths(skinId);
      const urls = NAV_ICON_FILE_KEYS.map((k) => paths[k]);
      try {
        const results = await Promise.all(
          urls.map(async (url) => {
            const res = await fetch(url, { method: "GET", cache: "no-store" });
            return res.ok;
          }),
        );
        return results.every(Boolean);
      } catch {
        return false;
      }
    };
    void (async () => {
      const checks = await Promise.all(
        candidates.map(async (id) => ({ id, ok: await checkSkinAssets(id) })),
      );
      if (cancelled) return;
      const visible = checks.filter((x) => x.ok).map((x) => x.id);
      const normalized = visible.includes(DEFAULT_NAV_SKIN_ID) ? visible : [DEFAULT_NAV_SKIN_ID];
      setAvailableNavSkinIds(normalized);
      setNavSkinAssetsChecked(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!navSkinAssetsChecked) return;
    if (!availableNavSkinIds.includes(navSkinId)) {
      setNavSkinIdState(DEFAULT_NAV_SKIN_ID);
    }
  }, [availableNavSkinIds, navSkinAssetsChecked, navSkinId]);

  /**
   * 認証状態の遷移（ログイン直後/再ログイン直後）の揺れでスキンを戻さない。
   * スキン変更可否は setNavSkinId 側で制御し、既存選択は保持する。
   */

  useEffect(() => {
    if (!apiBase || !canSendAuthenticatedRequest(token)) {
      setFixedCostsByMonth(legacyFixedCostsRecord());
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const { items } = await getFamilyFixedCosts();
        if (cancelled) return;
        if (items.length === 0) {
          const legacy = readLegacyFixedCostsFromLocalStorage();
          if (legacy.length > 0) {
            try {
              await putFamilyFixedCosts(
                legacy.map((x) => ({ category: x.category, amount: x.amount })),
              );
              try {
                localStorage.removeItem(FIXED_COSTS_KEY);
              } catch {
                /* ignore */
              }
              const again = await getFamilyFixedCosts();
              if (cancelled) return;
              const mapped = serverFixedCostsToItems(again.items).filter(
                (x) => x.amount > 0 && x.category.length > 0,
              );
              setFixedCostsByMonth(
                mapped.length === 0 ? {} : { [GLOBAL_FIXED_COSTS_KEY]: mapped },
              );
            } catch {
              if (!cancelled) {
                setFixedCostsByMonth({ [GLOBAL_FIXED_COSTS_KEY]: legacy });
              }
            }
            return;
          }
        }
        const mapped = serverFixedCostsToItems(items).filter(
          (x) => x.amount > 0 && x.category.length > 0,
        );
        setFixedCostsByMonth(
          mapped.length === 0 ? {} : { [GLOBAL_FIXED_COSTS_KEY]: mapped },
        );
      } catch {
        if (cancelled) return;
        setFixedCostsByMonth(legacyFixedCostsRecord());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, apiBase]);

  const setNavSkinId = useCallback(
    (id: string) => {
      if (!isKnownNavSkinId(id)) return false;
      if (!availableNavSkinIds.includes(id)) return false;
      const unlocked = id === DEFAULT_NAV_SKIN_ID || premiumNavUnlocked;
      if (!unlocked) return false;
      setNavSkinIdState(id);
      return true;
    },
    [availableNavSkinIds, premiumNavUnlocked],
  );

  const mergeOwnedNavSkinsFromServer = useCallback((ids: readonly string[]) => {
    if (!ids.length) return;
    setOwnedNavSkinIds((prev) => {
      const next = [...new Set([...prev, ...ids.filter((x) => typeof x === "string" && x.length > 0)])];
      return next.length === prev.length && next.every((x) => prev.includes(x)) ? prev : next;
    });
  }, []);

  const navIconPaths = useMemo(() => buildNavIconPaths(navSkinId), [navSkinId]);

  const navSkinOptions = useMemo<NavSkinOptionView[]>(
    () =>
      NAV_SKIN_TIER_CATALOG.filter((s) => {
        if (s.id === DEFAULT_NAV_SKIN_ID) return availableNavSkinIds.includes(DEFAULT_NAV_SKIN_ID);
        if (s.id === PREMIUM_NAV_SKIN_ID) {
          return PREMIUM_VARIANT_SKIN_IDS.some((pid) => availableNavSkinIds.includes(pid));
        }
        return false;
      }).map((s) => ({
        id: s.id,
        label: s.label,
        description: s.description,
        unlocked: s.id === DEFAULT_NAV_SKIN_ID || premiumNavUnlocked,
        selected:
          s.id === DEFAULT_NAV_SKIN_ID
            ? navSkinId === DEFAULT_NAV_SKIN_ID
            : isPremiumVariantSkinId(navSkinId),
      })),
    [availableNavSkinIds, navSkinId, premiumNavUnlocked],
  );

  const navPremiumVariantOptions = useMemo<NavSkinOptionView[]>(
    () =>
      PREMIUM_VARIANT_SKIN_IDS.filter((id) => availableNavSkinIds.includes(id)).map((id) => ({
        id,
        label: id,
        description: undefined,
        unlocked: premiumNavUnlocked,
        selected: navSkinId === id,
      })),
    [availableNavSkinIds, navSkinId, premiumNavUnlocked],
  );

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

  const setFixedCostsForMonth = useCallback(
    async (ym: string, items: FixedCostItem[]) => {
      if (!/^\d{4}-\d{2}$/.test(ym)) return;
      const cleaned = (Array.isArray(items) ? items : [])
        .map((x, i) => ({
          id: String(x?.id ?? `fixed-${i + 1}`),
          amount: Math.max(0, Math.round(Number(x?.amount ?? 0))),
          category: String(x?.category ?? "").trim().slice(0, 40),
        }))
        .filter((x) => Number.isFinite(x.amount) && x.amount > 0);
      if (!apiBase || !canSendAuthenticatedRequest(token)) {
        setFixedCostsByMonth(
          cleaned.length === 0 ? {} : { [GLOBAL_FIXED_COSTS_KEY]: cleaned },
        );
        return;
      }
      await putFamilyFixedCosts(
        cleaned.map((x) => ({ category: x.category, amount: x.amount })),
      );
      const { items: fresh } = await getFamilyFixedCosts();
      const mapped = serverFixedCostsToItems(fresh).filter(
        (x) => x.amount > 0 && x.category.length > 0,
      );
      setFixedCostsByMonth(
        mapped.length === 0 ? {} : { [GLOBAL_FIXED_COSTS_KEY]: mapped },
      );
    },
    [token, apiBase],
  );

  const value = useMemo(
    () => ({
      fontScale,
      fontMode,
      themeMode,
      fixedCostsByMonth,
      navSkinId,
      navIconPaths,
      navSkinOptions,
      navPremiumVariantOptions,
      availableNavSkinIds,
      premiumNavUnlocked,
      setFontScale,
      setFontMode,
      setThemeMode,
      setFixedCostsForMonth,
      setNavSkinId,
      mergeOwnedNavSkinsFromServer,
    }),
    [
      fontScale,
      fontMode,
      themeMode,
      fixedCostsByMonth,
      navSkinId,
      navIconPaths,
      navSkinOptions,
      navPremiumVariantOptions,
      availableNavSkinIds,
      premiumNavUnlocked,
      setFixedCostsForMonth,
      setNavSkinId,
      mergeOwnedNavSkinsFromServer,
    ],
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
