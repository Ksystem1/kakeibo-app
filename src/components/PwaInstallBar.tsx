import { useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { usePwaTargetDevice } from "../hooks/usePwaTargetDevice";
import {
  isPwaInstallBannerHidden,
  setPwaInstallBannerHidden,
  subscribePwaInstallPrefs,
} from "../lib/pwaInstallPrefs";
import styles from "./PwaInstallBar.module.css";

function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia("(display-mode: standalone)").matches) return true;
  if (window.matchMedia("(display-mode: minimal-ui)").matches) return true;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true;
}

function isIosTouch(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}

export function PwaInstallBar() {
  const { pathname, hash } = useLocation();
  const pwaTarget = usePwaTargetDevice();
  const [bannerHidden, setBannerHidden] = useState(isPwaInstallBannerHidden);
  const [standalone, setStandalone] = useState(isStandaloneDisplay);
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => subscribePwaInstallPrefs(() => setBannerHidden(isPwaInstallBannerHidden())), []);

  useEffect(() => {
    setStandalone(isStandaloneDisplay());
  }, [pwaTarget]);

  useEffect(() => {
    if (!pwaTarget || bannerHidden || standalone) {
      setDeferredPrompt(null);
      return;
    }
    const onBip = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setPwaInstallBannerHidden();
      setDeferredPrompt(null);
    };
    window.addEventListener("beforeinstallprompt", onBip);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBip);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, [pwaTarget, bannerHidden, standalone]);

  const showIosHint = isIosTouch() && !standalone;
  const showChromeInstall = deferredPrompt != null;
  const helpHash = hash.startsWith("#") ? hash.slice(1) : hash;
  const settingsHelpOpen = pathname === "/settings" && helpHash === "pwa-install-help";

  const visible =
    pwaTarget &&
    !bannerHidden &&
    !standalone &&
    !settingsHelpOpen &&
    (showChromeInstall || showIosHint);

  useEffect(() => {
    if (typeof document === "undefined") return;
    if (visible) {
      document.documentElement.dataset.pwaInstallBar = "1";
    } else {
      delete document.documentElement.dataset.pwaInstallBar;
    }
    return () => {
      delete document.documentElement.dataset.pwaInstallBar;
    };
  }, [visible]);

  const onInstallClick = useCallback(async () => {
    if (!deferredPrompt) return;
    try {
      await deferredPrompt.prompt();
      await deferredPrompt.userChoice;
    } catch {
      /* ユーザーが閉じた等 */
    }
    setDeferredPrompt(null);
  }, [deferredPrompt]);

  const onAlreadyHaveShortcut = useCallback(() => {
    setPwaInstallBannerHidden();
  }, []);

  if (!visible) return null;

  return (
    <div className={styles.bar} role="region" aria-label="アプリとして使う">
      <div className={styles.inner}>
        <p className={styles.text}>
          {showChromeInstall
            ? "ホーム画面に追加すると、次回からアプリのようにすぐ開けます。"
            : "Safari の「共有」から「ホーム画面に追加」で、アプリのように使えます。"}
        </p>
        <div className={styles.actions}>
          {showChromeInstall ? (
            <button type="button" className={styles.btnPrimary} onClick={onInstallClick}>
              ホームに追加
            </button>
          ) : null}
          <button type="button" className={styles.btnGhost} onClick={onAlreadyHaveShortcut}>
            追加済み・ショートカット利用中
          </button>
        </div>
      </div>
      <div className={styles.helpRow}>
        <Link className={styles.link} to="/settings#pwa-install-help">
          手順を設定で開く
        </Link>
      </div>
    </div>
  );
}
