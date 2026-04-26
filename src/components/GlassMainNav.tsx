import { useEffect, useRef, useState } from "react";
import {
  BookCheck,
  BookOpen,
  ClipboardCheck,
  Cpu,
  Lightbulb,
  LayoutDashboard,
  Rocket,
  ScanLine,
  Settings2,
  Shield,
  Sparkles,
  Users,
  Wallet,
} from "lucide-react";
import { NavLink } from "react-router-dom";
import { getVisibleMainNavItems } from "../config/mainNavItems";
import "./AppLayout.glassNav.css";

type Props = {
  isAdminUser: boolean;
  adminSupportNeedsReply: number;
};

/**
 * フローティング「ガラス」ピル型メイン導航（PC: 上中央 / スマホ: 下・セーフエリア内）
 */
export function GlassMainNav({ isAdminUser, adminSupportNeedsReply }: Props) {
  const FEATURE_MODAL_LAST_SEEN_KEY = "kakeibo:features-modal-last-seen";
  const FEATURE_MODAL_COOLDOWN_MS = 1000 * 60 * 60 * 24 * 14; // 14 days
  const items = getVisibleMainNavItems({ isAdmin: isAdminUser });
  const [pressedId, setPressedId] = useState<string | null>(null);
  const [showHowTo, setShowHowTo] = useState(false);
  const [showFeatures, setShowFeatures] = useState(false);
  const clearTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (clearTimerRef.current != null) {
        window.clearTimeout(clearTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const now = Date.now();
    const lastSeenRaw = window.localStorage.getItem(FEATURE_MODAL_LAST_SEEN_KEY);
    const lastSeen = lastSeenRaw ? Number(lastSeenRaw) : 0;
    if (!Number.isFinite(lastSeen) || now - lastSeen > FEATURE_MODAL_COOLDOWN_MS) {
      setShowFeatures(true);
      window.localStorage.setItem(FEATURE_MODAL_LAST_SEEN_KEY, String(now));
    }
  }, []);

  const triggerSpringPress = (id: string) => {
    setPressedId(id);
    if (clearTimerRef.current != null) {
      window.clearTimeout(clearTimerRef.current);
    }
    clearTimerRef.current = window.setTimeout(() => {
      setPressedId((prev) => (prev === id ? null : prev));
      clearTimerRef.current = null;
    }, 280);
  };

  const getNavIcon = (id: string) => {
    switch (id) {
      case "dashboard":
        return LayoutDashboard;
      case "kakeibo":
        return Wallet;
      case "import":
        return ScanLine;
      case "settings":
        return Settings2;
      case "admin":
        return Shield;
      case "features":
        return Sparkles;
      case "howto":
        return BookOpen;
      default:
        return Sparkles;
    }
  };

  return (
    <>
      <nav className="app-glass-nav" aria-label="メインメニュー" id="app-main-glass-menu">
        <ul className="app-glass-nav__list" role="list">
          {items.map((item) => (
            <li key={item.id} className="app-glass-nav__li">
              {item.kind === "action" ? (
                <button
                  type="button"
                  className={[
                    "app-glass-nav__link",
                    "app-glass-nav__button",
                    pressedId === item.id ? "is-pressed" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onPointerDown={() => triggerSpringPress(item.id)}
                  onClick={() => {
                    if (item.actionId === "howto") {
                      setShowHowTo(true);
                      return;
                    }
                    if (item.actionId === "features") {
                      setShowFeatures(true);
                      if (typeof window !== "undefined") {
                        window.localStorage.setItem(FEATURE_MODAL_LAST_SEEN_KEY, String(Date.now()));
                      }
                    }
                  }}
                >
                  <span className="app-glass-nav__icon-wrap" aria-hidden>
                    {(() => {
                      const Icon = getNavIcon(item.id);
                      return <Icon className="app-glass-nav__icon" strokeWidth={1.85} />;
                    })()}
                  </span>
                  <span className="app-glass-nav__text">{item.label}</span>
                </button>
              ) : (
                <NavLink
                  to={item.to ?? "/"}
                  end={item.end ?? false}
                  className={({ isActive }) =>
                    [
                      "app-glass-nav__link",
                      item.id === "admin" ? "app-glass-nav__link--admin" : "",
                      pressedId === item.id ? "is-pressed" : "",
                      isActive ? "is-active" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")
                  }
                  onPointerDown={() => triggerSpringPress(item.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      triggerSpringPress(item.id);
                    }
                  }}
                >
                  <span className="app-glass-nav__icon-wrap" aria-hidden>
                    {(() => {
                      const Icon = getNavIcon(item.id);
                      return <Icon className="app-glass-nav__icon" strokeWidth={1.85} />;
                    })()}
                  </span>
                  <span className="app-glass-nav__text">{item.label}</span>
                  {item.id === "admin" && adminSupportNeedsReply > 0 ? (
                    <span className="app-glass-nav__badge" title="サポート要返信">
                      {adminSupportNeedsReply > 99 ? "99+" : String(adminSupportNeedsReply)}
                    </span>
                  ) : null}
                </NavLink>
              )}
            </li>
          ))}
        </ul>
      </nav>
      {showFeatures ? (
        <div
          className="app-glass-nav-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="機能紹介"
          onClick={() => setShowFeatures(false)}
        >
          <div className="app-glass-nav-panel app-glass-nav-panel--compact" onClick={(e) => e.stopPropagation()}>
            <div className="app-glass-nav-panel__head">
              <strong className="app-glass-nav-panel__title">
                <Rocket className="app-glass-nav-panel__title-icon" strokeWidth={1.9} />
                直近アップデート
              </strong>
              <button type="button" className="app-glass-nav-panel__close" onClick={() => setShowFeatures(false)}>
                閉じる
              </button>
            </div>
            <ul className="app-glass-nav-panel__list">
              <li className="app-glass-nav-panel__item">
                <Sparkles className="app-glass-nav-panel__item-icon" strokeWidth={1.85} />
                接続元アイコン列（PC/スマホ/タブレット/不明）を追加
              </li>
              <li className="app-glass-nav-panel__item">
                <Lightbulb className="app-glass-nav-panel__item-icon" strokeWidth={1.85} />
                売上分析に予測シミュレーションとセグメント切替を追加
              </li>
              <li className="app-glass-nav-panel__item">
                <BookCheck className="app-glass-nav-panel__item-icon" strokeWidth={1.85} />
                日次・累積・予測の可視化を強化（目標・ツールチップ対応）
              </li>
            </ul>
          </div>
        </div>
      ) : null}
      {showHowTo ? (
        <div
          className="app-glass-nav-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="この画面の使い方"
          onClick={() => setShowHowTo(false)}
        >
          <div className="app-glass-nav-panel" onClick={(e) => e.stopPropagation()}>
            <div className="app-glass-nav-panel__head">
              <h3 className="app-glass-nav-panel__title">
                <Lightbulb className="app-glass-nav-panel__title-icon" strokeWidth={1.9} />
                この画面の使い方
              </h3>
              <button type="button" className="app-glass-nav-panel__close" onClick={() => setShowHowTo(false)}>
                閉じる
              </button>
            </div>
            <ul className="app-glass-nav-panel__list">
              <li className="app-glass-nav-panel__item">
                <Users className="app-glass-nav-panel__item-icon" strokeWidth={1.85} />
                「<span className="app-glass-nav-panel__hl">役割</span>」列のプルダウンで、家族ごとの権限を変更できます。
              </li>
              <li className="app-glass-nav-panel__item">
                <ClipboardCheck className="app-glass-nav-panel__item-icon" strokeWidth={1.85} />
                変更後は右側の「<span className="app-glass-nav-panel__hl">保存</span>」ボタンを押すことで反映されます。
              </li>
              <li className="app-glass-nav-panel__item">
                <Cpu className="app-glass-nav-panel__item-icon" strokeWidth={1.85} />
                「接続」列のアイコンにマウスを合わせると、詳細な「<span className="app-glass-nav-panel__hl">OS情報</span>」を確認できます。
              </li>
            </ul>
          </div>
        </div>
      ) : null}
    </>
  );
}
