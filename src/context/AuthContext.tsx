import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { FamilyRole } from "../lib/api";

const STORAGE_KEY = "kakeibo_token";

type User = {
  id: number;
  email: string;
  familyId?: number | null;
  /** サーバ users.family_role（未返却時は MEMBER 扱い） */
  familyRole?: FamilyRole;
  isAdmin?: boolean;
  /** サーバ users.subscription_status（例: active / inactive） */
  subscriptionStatus?: string;
  /** ISO 8601（Stripe current_period_end） */
  subscriptionPeriodEndAt?: string | null;
  subscriptionCancelAtPeriodEnd?: boolean;
};

type AuthState = {
  token: string | null;
  user: User | null;
  setSession: (token: string, user: User) => void;
  setUser: (user: User | null) => void;
  logout: () => void;
};

const AuthContext = createContext<AuthState | null>(null);

function readStoredToken() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => readStoredToken());
  const [user, setUser] = useState<User | null>(null);

  const setSession = useCallback((t: string, u: User) => {
    setToken(t);
    setUser(u);
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      /* ignore */
    }
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo(
    () => ({ token, user, setSession, setUser, logout }),
    [token, user, setSession, setUser, logout],
  );

  return (
    <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}

export function getStoredToken(): string | null {
  return readStoredToken();
}
