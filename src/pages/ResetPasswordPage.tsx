import { FormEvent, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { resetPasswordRequest } from "../lib/api";
import styles from "../components/LoginScreen.module.css";

const PW_RE = /^[a-zA-Z0-9]{8,}$/;

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const initialToken = useMemo(() => params.get("token") || "", [params]);
  const [token, setToken] = useState(initialToken);
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    if (!token.trim()) {
      setError("トークンを入力してください（メール内リンクから開いてください）。");
      return;
    }
    if (!PW_RE.test(password)) {
      setError("パスワードは英数字8文字以上にしてください。");
      return;
    }
    setLoading(true);
    try {
      await resetPasswordRequest(token.trim(), password);
      setMessage("パスワードを更新しました。ログインしてください。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新に失敗しました");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.page}>
      <main className={styles.panel} style={{ gridColumn: "1 / -1" }}>
        <div className={styles.card} style={{ maxWidth: 440, margin: "0 auto" }}>
          <header className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>新しいパスワード</h2>
          </header>
          <form className={styles.form} onSubmit={handleSubmit}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="rs-token">
                リセットトークン
              </label>
              <input
                id="rs-token"
                className={styles.input}
                type="text"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                disabled={loading}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="rs-pw">
                新パスワード（英数字8文字以上）
              </label>
              <input
                id="rs-pw"
                className={styles.input}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loading}
              />
            </div>
            {error ? (
              <p className={styles.error} role="alert">
                {error}
              </p>
            ) : null}
            {message ? (
              <p className={styles.hint} style={{ color: "var(--accent)" }}>
                {message}
              </p>
            ) : null}
            <button type="submit" className={styles.submit} disabled={loading}>
              {loading ? "更新中…" : "パスワードを更新"}
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
