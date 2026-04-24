/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/vanillajs" />

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

interface ImportMetaEnv {
  /** 開発時のみ vite.config が参照（既定 http://127.0.0.1:3456） */
  readonly VITE_API_PROXY_TARGET?: string;
  readonly VITE_API_URL?: string;
  /** 開発の API ベース（未設定時は 127.0.0.1:3456/api） */
  readonly VITE_DEV_API_BASE?: string;
  readonly VITE_API_APPEND_PREFIX?: string;
  /** パスキー単体新規登録ページの検証用。本番では原則未設定。 */
  readonly VITE_ALLOW_PASSKEY_STANDALONE?: string;
  /** GET /config のフル URL（例: http://127.0.0.1:3456/api/config）。未設定なら BASE/config */
  readonly VITE_STRIPE_CONFIG_URL?: string;
  readonly VITE_PUBLIC_ORIGIN?: string;
  readonly VITE_DEV_USER_ID?: string;
  readonly VITE_DEFAULT_USER_ID?: string;
  readonly VITE_STRIPE_TEST_PUBLIC_KEY?: string;
  /** 本番ビルドで設定画面の Stripe Checkout ボタンを出す（ローカル dev は未設定でも表示） */
  readonly VITE_STRIPE_CHECKOUT?: string;
  readonly VITE_STRIPE_TEST_CHECKOUT?: string;
}
