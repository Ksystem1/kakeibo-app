/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 開発時のみ vite.config が参照（既定 http://127.0.0.1:3456） */
  readonly VITE_API_PROXY_TARGET?: string;
  readonly VITE_API_URL?: string;
  readonly VITE_PUBLIC_ORIGIN?: string;
  readonly VITE_DEV_USER_ID?: string;
  readonly VITE_DEFAULT_USER_ID?: string;
}
