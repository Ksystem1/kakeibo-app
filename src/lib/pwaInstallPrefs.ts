/** フローティングの「アプリ化」案内を出さない（インストール済・ショートカット利用など） */
export const PWA_INSTALL_BANNER_HIDE_KEY = "kakeibo-pwa-install-banner-hide";

const CHANGED = "kakeibo-pwa-prefs-changed";

export function isPwaInstallBannerHidden(): boolean {
  try {
    return localStorage.getItem(PWA_INSTALL_BANNER_HIDE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setPwaInstallBannerHidden(): void {
  try {
    localStorage.setItem(PWA_INSTALL_BANNER_HIDE_KEY, "1");
  } catch {
    /* private mode 等 */
  }
  window.dispatchEvent(new Event(CHANGED));
}

export function clearPwaInstallBannerHidden(): void {
  try {
    localStorage.removeItem(PWA_INSTALL_BANNER_HIDE_KEY);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(CHANGED));
}

export function subscribePwaInstallPrefs(cb: () => void): () => void {
  const on = () => cb();
  window.addEventListener(CHANGED, on);
  window.addEventListener("storage", on);
  return () => {
    window.removeEventListener(CHANGED, on);
    window.removeEventListener("storage", on);
  };
}
