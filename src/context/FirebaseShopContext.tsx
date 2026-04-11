import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from "firebase/auth";
import { doc, getFirestore, onSnapshot } from "firebase/firestore";
import { getFirebaseShopWebConfig } from "../lib/firebaseShop";

export type FirebaseShopContextValue = {
  /** Web 用 Firebase 設定が揃っている */
  enabled: boolean;
  /** 初回 onAuthStateChanged まで true（enabled が false のときは常に false） */
  authLoading: boolean;
  user: User | null;
  /** Firestore users/{uid}.owned_nav_skins（配列） */
  firestoreOwnedNavSkins: string[];
  signInWithGoogle: () => Promise<void>;
  signOutFirebase: () => Promise<void>;
};

const defaultValue: FirebaseShopContextValue = {
  enabled: false,
  authLoading: false,
  user: null,
  firestoreOwnedNavSkins: [],
  signInWithGoogle: async () => {},
  signOutFirebase: async () => {},
};

const FirebaseShopContext = createContext<FirebaseShopContextValue>(defaultValue);

export function FirebaseShopProvider({ children }: { children: ReactNode }) {
  const config = useMemo(() => getFirebaseShopWebConfig(), []);
  const enabled = Boolean(config);

  const app: FirebaseApp | null = useMemo(() => {
    if (!config) return null;
    return getApps().length > 0 ? getApps()[0]! : initializeApp(config);
  }, [config]);

  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(!enabled);
  const [firestoreOwnedNavSkins, setFirestoreOwnedNavSkins] = useState<
    string[]
  >([]);

  useEffect(() => {
    if (!app) {
      setAuthReady(true);
      return;
    }
    const auth = getAuth(app);
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthReady(true);
    });
    return () => unsub();
  }, [app]);

  useEffect(() => {
    if (!app || !user) {
      setFirestoreOwnedNavSkins([]);
      return;
    }
    const db = getFirestore(app);
    const ref = doc(db, "users", user.uid);
    const unsub = onSnapshot(ref, (snap) => {
      if (!snap.exists()) {
        setFirestoreOwnedNavSkins([]);
        return;
      }
      const raw = snap.data()?.owned_nav_skins;
      const list = Array.isArray(raw)
        ? raw.filter((x): x is string => typeof x === "string" && x.length > 0)
        : [];
      setFirestoreOwnedNavSkins(list);
    });
    return () => unsub();
  }, [app, user]);

  const signInWithGoogle = useCallback(async () => {
    if (!app) return;
    const auth = getAuth(app);
    const provider = new GoogleAuthProvider();
    await signInWithPopup(auth, provider);
  }, [app]);

  const signOutFirebase = useCallback(async () => {
    if (!app) return;
    await signOut(getAuth(app));
  }, [app]);

  const value = useMemo<FirebaseShopContextValue>(
    () => ({
      enabled,
      authLoading: enabled && !authReady,
      user,
      firestoreOwnedNavSkins,
      signInWithGoogle,
      signOutFirebase,
    }),
    [
      enabled,
      authReady,
      user,
      firestoreOwnedNavSkins,
      signInWithGoogle,
      signOutFirebase,
    ],
  );

  return (
    <FirebaseShopContext.Provider value={value}>
      {children}
    </FirebaseShopContext.Provider>
  );
}

export function useFirebaseShop(): FirebaseShopContextValue {
  return useContext(FirebaseShopContext);
}
