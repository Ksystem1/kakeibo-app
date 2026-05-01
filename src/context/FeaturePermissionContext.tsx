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
import type { FeaturePermissionSummaryItem } from "../lib/api";
import { getFeaturePermissionsSummary } from "../lib/api";
import { resolveFeatureDisplayName, type FeatureDisplayLocale } from "../i18n/featureLabels";

export type FeaturePermissionContextValue = {
  loading: boolean;
  error: string | null;
  tableMissing: boolean;
  effectivePlan: "standard" | "premium" | null;
  allowedMap: Record<string, boolean> | null;
  /** GET /feature-permissions の生データ（表示名フォールバック用） */
  summaryItems: FeaturePermissionSummaryItem[] | null;
  refresh: () => Promise<void>;
  /** マップ未取得時は true（表示を止めない） */
  allowedFor: (feature: string) => boolean;
  /** feature_key に対応するユーザー向け表示名（i18n 辞書優先） */
  displayNameFor: (feature: string) => string;
};

const FeaturePermissionContext = createContext<FeaturePermissionContextValue | null>(null);

export function FeaturePermissionProvider({
  children,
  displayLocale = "ja",
}: {
  children: ReactNode;
  /** アプリ全体の表示ロケールに合わせて渡す（将来の i18n 切替用） */
  displayLocale?: FeatureDisplayLocale;
}) {
  const { token } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tableMissing, setTableMissing] = useState(false);
  const [effectivePlan, setEffectivePlan] = useState<"standard" | "premium" | null>(null);
  const [allowedMap, setAllowedMap] = useState<Record<string, boolean> | null>(null);
  const [summaryItems, setSummaryItems] = useState<FeaturePermissionSummaryItem[] | null>(null);

  const refresh = useCallback(async () => {
    if (!token) {
      setAllowedMap(null);
      setSummaryItems(null);
      setEffectivePlan(null);
      setError(null);
      setTableMissing(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const r = await getFeaturePermissionsSummary();
      setEffectivePlan(r.effectivePlan ?? null);
      setTableMissing(r.tableMissing === true);
      const items = r.items ?? [];
      setSummaryItems(items);
      const m: Record<string, boolean> = {};
      for (const it of items) {
        m[String(it.feature).trim().toLowerCase()] = Boolean(it.allowed);
      }
      setAllowedMap(m);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setAllowedMap(null);
      setSummaryItems(null);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const allowedFor = useCallback(
    (feature: string) => {
      const k = String(feature).trim().toLowerCase();
      if (allowedMap == null) return true;
      if (!Object.prototype.hasOwnProperty.call(allowedMap, k)) return true;
      return Boolean(allowedMap[k]);
    },
    [allowedMap],
  );

  const displayNameFor = useCallback(
    (feature: string) =>
      resolveFeatureDisplayName(feature, { locale: displayLocale, summaryItems }),
    [displayLocale, summaryItems],
  );

  const value = useMemo(
    (): FeaturePermissionContextValue => ({
      loading,
      error,
      tableMissing,
      effectivePlan,
      allowedMap,
      summaryItems,
      refresh,
      allowedFor,
      displayNameFor,
    }),
    [
      loading,
      error,
      tableMissing,
      effectivePlan,
      allowedMap,
      summaryItems,
      refresh,
      allowedFor,
      displayNameFor,
    ],
  );

  return (
    <FeaturePermissionContext.Provider value={value}>{children}</FeaturePermissionContext.Provider>
  );
}

export function useFeaturePermissions(): FeaturePermissionContextValue {
  const ctx = useContext(FeaturePermissionContext);
  if (!ctx) {
    throw new Error("useFeaturePermissions は FeaturePermissionProvider 内で使ってください");
  }
  return ctx;
}
