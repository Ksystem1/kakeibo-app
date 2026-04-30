import { FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { forgotPasswordRequest } from "../lib/api";
import styles from "../components/LoginScreen.module.css";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(null);
    const em = email.trim().toLowerCase();
    if (!em) {
      setError("メールアドレスを入力してください。");
      return;
    }
    setLoading(true);
    try {
      const r = await forgotPasswordRequest(em);
      let msg = r.message ?? "処理しました。";
      if (import.meta.env.DEV && r.debug_reset_token) {
        msg += ` 開発用トークン: ${r.debug_reset_token}（/reset-password で使用）`;
      }
      setDone(msg);
    } catch (err) {
      setError(err instanceof Error ? err.message : "エラーが発生しました");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.page}>
      <main className={styles.panel} style={{ gridColumn: "1 / -1" }}>
        <div className={styles.card} style={{ maxWidth: 440, margin: "0 auto" }}>
          <header className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>パスワード再設定</h2>
          </header>
          <form className={styles.form} onSubmit={handleSubmit}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="fp-email">
                メールアドレス
              </label>
              <input
                id="fp-email"
                className={styles.input}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={loading}
              />
            </div>
            {error ? (
              <p className={styles.error} role="alert">
                {error}
              </p>
            ) : null}
            {done ? (
              <p className={styles.hint} style={{ color: "var(--accent)" }}>
                {done}
              </p>
            ) : null}
            <button type="submit" className={styles.submit} disabled={loading}>
              {loading ? "送信中…" : "再設定メールを送信（登録時のみ有効）"}
            </button>
          </form>
          <p className={styles.footer}>
            <Link to="/login" className={styles.link}>
              ログインへ
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
