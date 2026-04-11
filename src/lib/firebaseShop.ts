/**
 * スキン購入フロー用の Firebase Web アプリ設定（Vite 環境変数）。
 * いずれか欠ける場合は Firebase 連携を無効化し、従来の localStorage のみで動作する。
 */
export type FirebaseShopWebConfig = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
};

function pick(name: string): string {
  const v = (import.meta.env as Record<string, string | undefined>)[name];
  return v != null && String(v).trim() !== "" ? String(v).trim() : "";
}

export function getFirebaseShopWebConfig(): FirebaseShopWebConfig | null {
  const apiKey = pick("VITE_FIREBASE_API_KEY");
  const authDomain = pick("VITE_FIREBASE_AUTH_DOMAIN");
  const projectId = pick("VITE_FIREBASE_PROJECT_ID");
  const storageBucket = pick("VITE_FIREBASE_STORAGE_BUCKET");
  const messagingSenderId = pick("VITE_FIREBASE_MESSAGING_SENDER_ID");
  const appId = pick("VITE_FIREBASE_APP_ID");
  if (
    !apiKey ||
    !authDomain ||
    !projectId ||
    !storageBucket ||
    !messagingSenderId ||
    !appId
  ) {
    return null;
  }
  return {
    apiKey,
    authDomain,
    projectId,
    storageBucket,
    messagingSenderId,
    appId,
  };
}
