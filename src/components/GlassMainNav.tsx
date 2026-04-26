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

  return (
    <nav className="app-glass-nav" aria-label="メインメニュー" id="app-main-glass-menu">
      <ul className="app-glass-nav__list" role="list">
        {items.map((item) => (
          <li key={item.id} className="app-glass-nav__li">
            <NavLink
              to={item.to}
              end={item.end ?? false}
              className={({ isActive }) =>
                [
                  "app-glass-nav__link",
                  item.id === "admin" ? "app-glass-nav__link--admin" : "",
                  isActive ? "is-active" : "",
                ]
                  .filter(Boolean)
                  .join(" ")
              }
            >
              <span className="app-glass-nav__text">{item.label}</span>
              {item.id === "admin" && adminSupportNeedsReply > 0 ? (
                <span className="app-glass-nav__badge" title="サポート要返信">
                  {adminSupportNeedsReply > 99 ? "99+" : String(adminSupportNeedsReply)}
                </span>
              ) : null}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
