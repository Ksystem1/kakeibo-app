/** フローティングの「アプリ化」案内を出さない（インストール済・ショートカット利用など） */
export const PWA_INSTALL_BANNER_HIDE_KEY = "kakeibo-pwa-install-banner-hide";
const PWA_INSTALL_PROMPT_COOLDOWN_UNTIL_KEY = "kakeibo-pwa-install-prompt-cooldown-until";
const PWA_INSTALL_PROMPT_SESSION_KEY = "kakeibo-pwa-install-prompt-session-ready";
const DEFAULT_COOLDOWN_DAYS = 7;

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

export function markPwaInstallPromptReadyForSession(): void {
  try {
    sessionStorage.setItem(PWA_INSTALL_PROMPT_SESSION_KEY, "1");
  } catch {
    /* private mode 等 */
  }
}

export function consumePwaInstallPromptReadyForSession(): boolean {
  try {
    const hit = sessionStorage.getItem(PWA_INSTALL_PROMPT_SESSION_KEY) === "1";
    if (hit) sessionStorage.removeItem(PWA_INSTALL_PROMPT_SESSION_KEY);
    return hit;
  } catch {
    return false;
  }
}

export function isPwaInstallPromptCooldownActive(nowMs = Date.now()): boolean {
  try {
    const raw = localStorage.getItem(PWA_INSTALL_PROMPT_COOLDOWN_UNTIL_KEY);
    const until = raw ? Number(raw) : 0;
    return Number.isFinite(until) && until > nowMs;
  } catch {
    return false;
  }
}

export function setPwaInstallPromptCooldown(days = DEFAULT_COOLDOWN_DAYS): void {
  const safeDays = Number.isFinite(days) && days > 0 ? days : DEFAULT_COOLDOWN_DAYS;
  const until = Date.now() + safeDays * 24 * 60 * 60 * 1000;
  try {
    localStorage.setItem(PWA_INSTALL_PROMPT_COOLDOWN_UNTIL_KEY, String(until));
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
