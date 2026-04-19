import { useAuth } from "../context/AuthContext";
import { normalizeFamilyRole } from "../lib/api";
import { KakeiboDashboard } from "./KakeiboDashboard";
import { SimpleKidDashboard } from "./SimpleKidDashboard";

/**
 * `/` の入口: KID はお小遣い帳専用ページ、それ以外は従来の家計簿ダッシュ。
 * リロード直後は user が null の間だけ短い読み込み（/auth/me 完了まで）。
 */
export function HomeLedgerGate() {
  const { token, user } = useAuth();

  if (token && user == null) {
    return (
      <div
        className="home-ledger-gate-loading"
        style={{
          padding: "2rem 1rem",
          textAlign: "center",
          color: "var(--text-muted, #64748b)",
          fontSize: "0.95rem",
        }}
      >
        ユーザー情報を読み込み中です…
      </div>
    );
  }

  if (normalizeFamilyRole(user?.familyRole) === "KID") {
    return <SimpleKidDashboard />;
  }

  return <KakeiboDashboard />;
}
