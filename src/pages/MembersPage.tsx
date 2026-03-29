import { FormEvent, useCallback, useEffect, useState } from "react";
import { getFamilyMembers, inviteFamilyMember } from "../lib/api";
import styles from "../components/KakeiboDashboard.module.css";

export function MembersPage() {
  const [items, setItems] = useState<
    Array<{
      id: number;
      email: string;
      display_name: string | null;
      role: string;
    }>
  >([]);
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await getFamilyMembers();
      setItems(r.items ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onInvite(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    setErr(null);
    setLoading(true);
    try {
      const r = await inviteFamilyMember(email.trim().toLowerCase());
      let m = r.message ?? "招待しました";
      if (r.debug_invite_token) {
        m += `（開発トークン: ${r.debug_invite_token}）`;
      }
      setMsg(m);
      setEmail("");
      await load();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.wrap}>
      <h1 className={styles.title}>家族・利用ユーザー</h1>
      <p className={styles.sub}>
        同じ家族に紐づいた人は取引の入力・閲覧ができます。初期はご本人＋招待メンバー。将来は公開設定を拡張可能です。
      </p>
      {err ? (
        <p className={styles.err} role="alert">
          {err}
        </p>
      ) : null}
      {msg ? <p style={{ color: "var(--accent)" }}>{msg}</p> : null}

      <h2 className={styles.sectionTitle}>メンバー一覧</h2>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>メール</th>
              <th>表示名</th>
              <th>権限</th>
            </tr>
          </thead>
          <tbody>
            {items.map((m) => (
              <tr key={m.id}>
                <td>{m.email}</td>
                <td>{m.display_name ?? "—"}</td>
                <td>{m.role === "owner" ? "オーナー" : "メンバー"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className={styles.sectionTitle}>メールで招待（妻など）</h2>
      <form
        onSubmit={onInvite}
        style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}
      >
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="partner@example.com"
          className={styles.monthInput}
          style={{ flex: "1 1 220px" }}
        />
        <button
          type="submit"
          className={`${styles.btn} ${styles.btnPrimary}`}
          disabled={loading}
        >
          招待を登録
        </button>
      </form>
    </div>
  );
}
