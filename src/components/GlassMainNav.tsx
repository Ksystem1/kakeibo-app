import { useEffect, useRef, useState } from "react";
import confetti from "canvas-confetti";
import {
  ArrowRight,
  BookOpen,
  ClipboardCheck,
  FolderSync,
  Lightbulb,
  LayoutDashboard,
  Rocket,
  ScanLine,
  Settings2,
  Shield,
  Sparkles,
  Target,
  WalletCards,
  Wallet,
} from "lucide-react";
import { NavLink, useNavigate } from "react-router-dom";
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
  const navigate = useNavigate();
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
                  aria-label={item.label}
                  title={item.label}
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
                  aria-label={item.label}
                  title={item.label}
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
              <li className="app-glass-nav-panel__catch">
                あなたの家計管理を、もっとスマートに、もっと楽しく。
              </li>
            </ul>
            <div className="app-glass-nav-feature-grid">
              <article className="app-glass-nav-feature-card">
                <span className="app-glass-nav-feature-card__icon" aria-hidden>
                  <FolderSync strokeWidth={1.95} />
                </span>
                <h4 className="app-glass-nav-feature-card__title">全自動取込</h4>
                <p className="app-glass-nav-feature-card__desc">
                  「おまかせ取込」で銀行やカードの明細を自動連携。入力の手間をゼロに。
                </p>
              </article>
              <article className="app-glass-nav-feature-card">
                <span className="app-glass-nav-feature-card__icon" aria-hidden>
                  <Target strokeWidth={1.95} />
                </span>
                <h4 className="app-glass-nav-feature-card__title">未来予測</h4>
                <p className="app-glass-nav-feature-card__desc">
                  AIが翌月の支出をシミュレーション。貯金の目標達成をしっかりサポート。
                </p>
              </article>
              <article className="app-glass-nav-feature-card">
                <span className="app-glass-nav-feature-card__icon" aria-hidden>
                  <Sparkles strokeWidth={1.95} />
                </span>
                <h4 className="app-glass-nav-feature-card__title">高度な分析</h4>
                <p className="app-glass-nav-feature-card__desc">
                  カテゴリ別の支出を美しいグラフで可視化。無駄遣いポイントも一目瞭然。
                </p>
              </article>
            </div>
            <div className="app-glass-nav-panel__media-placeholder">ここにチュートリアルGIF / 動画を追加できます</div>
            <div className="app-glass-nav-panel__actions">
              <button
                type="button"
                className="app-glass-nav-cta"
                onClick={() => {
                  setShowFeatures(false);
                  void navigate("/dashboard");
                }}
              >
                さっそく使ってみる
                <ArrowRight className="app-glass-nav-cta__icon" strokeWidth={2.1} />
              </button>
            </div>
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
            <div className="app-glass-nav-steps">
              <section className="app-glass-nav-step">
                <div className="app-glass-nav-step__badge">Step 01</div>
                <div className="app-glass-nav-step__body">
                  <h4 className="app-glass-nav-step__title">
                    <WalletCards className="app-glass-nav-panel__item-icon" strokeWidth={1.85} />
                    連携する
                  </h4>
                  <p className="app-glass-nav-step__desc">「おまかせ取込」から銀行口座やカードを登録しましょう。</p>
                </div>
              </section>
              <div className="app-glass-nav-step__divider" aria-hidden />
              <section className="app-glass-nav-step">
                <div className="app-glass-nav-step__badge">Step 02</div>
                <div className="app-glass-nav-step__body">
                  <h4 className="app-glass-nav-step__title">
                    <ClipboardCheck className="app-glass-nav-panel__item-icon" strokeWidth={1.85} />
                    確認する
                  </h4>
                  <p className="app-glass-nav-step__desc">「家計簿」タブで、自動で分類された支出をチェック。</p>
                </div>
              </section>
              <div className="app-glass-nav-step__divider" aria-hidden />
              <section className="app-glass-nav-step">
                <div className="app-glass-nav-step__badge">Step 03</div>
                <div className="app-glass-nav-step__body">
                  <h4 className="app-glass-nav-step__title">
                    <LayoutDashboard className="app-glass-nav-panel__item-icon" strokeWidth={1.85} />
                    振り返る
                  </h4>
                  <p className="app-glass-nav-step__desc">「ダッシュボード」で今月の予算残高を確認して、賢く節約！</p>
                </div>
              </section>
            </div>
            <div className="app-glass-nav-panel__media-placeholder">ここに操作GIF / ミニ動画を挿入できます</div>
            <div className="app-glass-nav-panel__actions">
              <button
                type="button"
                className="app-glass-nav-cta"
                onClick={() => {
                  confetti({
                    particleCount: 90,
                    spread: 78,
                    startVelocity: 34,
                    origin: { y: 0.68 },
                  });
                  setShowHowTo(false);
                  void navigate("/");
                }}
              >
                さっそく使ってみる
                <ArrowRight className="app-glass-nav-cta__icon" strokeWidth={2.1} />
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
