/**
 * 新しい Service Worker をユーザー操作なしで有効化する（現在のタブはリロードしない）。
 * 次回起動・次回フォーカス時の fetch で新バンドルが効きやすくする。
 */

export async function silentlyActivateWaitingServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return;
  if (reg.waiting) {
    try {
      reg.waiting.postMessage({ type: "SKIP_WAITING" });
    } catch {
      /* ignore */
    }
  }
  try {
    await reg.update();
  } catch {
    /* ignore */
  }
}

export function registerPwaBackgroundUpdateChecks(): void {
  if (typeof document === "undefined") return;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    void navigator.serviceWorker.getRegistration().then((r) => {
      void r?.update();
    });
  });
}
