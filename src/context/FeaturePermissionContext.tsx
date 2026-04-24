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
import { getFeaturePermissionsSummary } from "../lib/api";

export type FeaturePermissionContextValue = {
  loading: boolean;
  error: string | null;
  tableMissing: boolean;
  effectivePlan: "standard" | "premium" | null;
  allowedMap: Record<string, boolean> | null;
  refresh: () => Promise<void>;
  /** マップ未取得時は true（表示を止めない） */
  allowedFor: (feature: string) => boolean;
};

const FeaturePermissionContext = createContext<FeaturePermissionContextValue | null>(null);

export function FeaturePermissionProvider({ children }: { children: ReactNode }) {
  const { token } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tableMissing, setTableMissing] = useState(false);
  const [effectivePlan, setEffectivePlan] = useState<"standard" | "premium" | null>(null);
  const [allowedMap, setAllowedMap] = useState<Record<string, boolean> | null>(null);

  const refresh = useCallback(async () => {
    if (!token) {
      setAllowedMap(null);
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
      const m: Record<string, boolean> = {};
      for (const it of r.items || []) {
        m[String(it.feature).trim()] = Boolean(it.allowed);
      }
      setAllowedMap(m);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setAllowedMap(null);
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

  const value = useMemo(
    (): FeaturePermissionContextValue => ({
      loading,
      error,
      tableMissing,
      effectivePlan,
      allowedMap,
      refresh,
      allowedFor,
    }),
    [loading, error, tableMissing, effectivePlan, allowedMap, refresh, allowedFor],
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
