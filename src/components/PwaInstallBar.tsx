import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { usePwaTargetDevice } from "../hooks/usePwaTargetDevice";
import {
  consumePwaInstallPromptReadyForSession,
  isPwaInstallPromptCooldownActive,
  isPwaInstallBannerHidden,
  setPwaInstallPromptCooldown,
  setPwaInstallBannerHidden,
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

function isAndroid(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android/i.test(navigator.userAgent);
}

export function PwaInstallBar() {
  const { pathname } = useLocation();
  const pwaTarget = usePwaTargetDevice();
  const [bannerHidden, setBannerHidden] = useState(isPwaInstallBannerHidden());
  const [standalone, setStandalone] = useState(isStandaloneDisplay);
  const [readyByLoginSession, setReadyByLoginSession] = useState(false);
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    setStandalone(isStandaloneDisplay());
  }, [pwaTarget]);

  useEffect(() => {
    setReadyByLoginSession(consumePwaInstallPromptReadyForSession());
  }, []);

  useEffect(() => {
    if (!pwaTarget || bannerHidden || standalone || !readyByLoginSession) {
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
  }, [pwaTarget, bannerHidden, standalone, readyByLoginSession]);

  const showIosHint = isIosTouch() && !standalone;
  const showAndroidHint = isAndroid() && !standalone;
  const showChromeInstall = deferredPrompt != null;
  const isHomeTop = pathname === "/";
  const inCooldown = useMemo(() => isPwaInstallPromptCooldownActive(), []);

  const visible =
    isHomeTop &&
    pwaTarget &&
    readyByLoginSession &&
    !inCooldown &&
    !bannerHidden &&
    !standalone &&
    (showChromeInstall || showIosHint || showAndroidHint);

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
    setBannerHidden(true);
  }, []);

  const onClose = useCallback(() => {
    setPwaInstallPromptCooldown(7);
    setReadyByLoginSession(false);
    setDeferredPrompt(null);
  }, []);

  if (!visible) return null;

  return (
    <div className={styles.backdrop} role="presentation">
      <section className={styles.modal} role="dialog" aria-modal="true" aria-label="ホーム画面に追加">
        <h2 className={styles.title}>アプリとして使うと便利です</h2>
        <p className={styles.text}>ホーム画面に追加すると、次回からワンタップで家計簿を開けます。</p>
        <ol className={styles.steps}>
          {showIosHint ? (
            <>
              <li>Safari 下部の「共有（四角に矢印）」を押す</li>
              <li>「ホーム画面に追加」を選択する</li>
            </>
          ) : (
            <>
              <li>ブラウザ右上のメニュー（︙）を開く</li>
              <li>「アプリをインストール」または「ホーム画面に追加」を選択する</li>
            </>
          )}
        </ol>
        <div className={styles.actions}>
          {showChromeInstall ? (
            <button type="button" className={styles.btnPrimary} onClick={onInstallClick}>
              インストールする
            </button>
          ) : null}
          <button type="button" className={styles.btnGhost} onClick={onClose}>
            閉じる
          </button>
          <button type="button" className={styles.btnGhost} onClick={onAlreadyHaveShortcut}>
            今後は表示しない
          </button>
        </div>
      </section>
    </div>
  );
}
