import { useEffect, useRef, useState } from "react";
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
                    }
                  }}
                >
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
              <strong>直近アップデート</strong>
              <button type="button" className="app-glass-nav-panel__close" onClick={() => setShowFeatures(false)}>
                閉じる
              </button>
            </div>
            <ul className="app-glass-nav-panel__list">
              <li>接続元アイコン列（PC/スマホ/タブレット/不明）を追加</li>
              <li>売上分析に予測シミュレーションとセグメント切替を追加</li>
              <li>日次・累積・予測の可視化を強化（目標・ツールチップ対応）</li>
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
              <h3 style={{ margin: 0, fontSize: "1rem" }}>この画面の使い方</h3>
              <button type="button" className="app-glass-nav-panel__close" onClick={() => setShowHowTo(false)}>
                閉じる
              </button>
            </div>
            <ol className="app-glass-nav-panel__list app-glass-nav-panel__list--ordered">
              <li>「役割」列のプルダウンで、家族ごとの権限を変更できます。</li>
              <li>変更後は右側の「反映」または「保存」ボタンを押すことで適用されます。</li>
              <li>「接続」列のアイコンにマウスを合わせると、OS情報を確認できます。</li>
            </ol>
          </div>
        </div>
      ) : null}
    </>
  );
}
