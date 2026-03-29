import { FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { registerRequest } from "../lib/api";
import styles from "../components/LoginScreen.module.css";

const PW_RE = /^[a-zA-Z0-9]{8,}$/;

export function RegisterPage() {
  const navigate = useNavigate();
  const { setSession } = useAuth();
  const [email, setEmail] = useState("");
  const [loginName, setLoginName] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [familyName, setFamilyName] = useState("マイ家族");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const em = email.trim().toLowerCase();
    if (!em || !em.includes("@")) {
      setError("有効なメールアドレスを入力してください。");
      return;
    }
    if (!PW_RE.test(password)) {
      setError("パスワードは英数字8文字以上にしてください。");
      return;
    }
    setSubmitting(true);
    try {
      const r = await registerRequest({
        email: em,
        password,
        login_name: loginName.trim() || undefined,
        display_name: displayName.trim() || undefined,
        family_name: familyName.trim() || undefined,
      });
      setSession(r.token, {
        id: r.user.id,
        email: r.user.email,
        familyId: r.user.familyId,
      });
      navigate("/kakeibo", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "登録に失敗しました");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.page}>
      <aside className={styles.hero}>
        <div className={styles.heroInner}>
          <span className={styles.badge}>Kakeibo</span>
          <h1 className={styles.heroTitle}>はじめまして</h1>
          <p className={styles.heroDesc}>
            家族用の家計簿を作成します。初期はご本人＋招待したメンバーまで。安定後に他ユーザー開放・紐付けを拡張できます。
          </p>
        </div>
      </aside>
      <main className={styles.panel}>
        <div className={styles.card}>
          <header className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>新規登録</h2>
            <p className={styles.cardSub}>メールとパスワードでアカウントを作成</p>
          </header>
          <form className={styles.form} onSubmit={handleSubmit}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="reg-email">
                メールアドレス（必須）
              </label>
              <input
                id="reg-email"
                className={styles.input}
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="reg-login">
                ログインID（任意・メール以外でログインする場合）
              </label>
              <input
                id="reg-login"
                className={styles.input}
                type="text"
                value={loginName}
                onChange={(e) => setLoginName(e.target.value)}
                disabled={submitting}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="reg-name">
                表示名（任意）
              </label>
              <input
                id="reg-name"
                className={styles.input}
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                disabled={submitting}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="reg-family">
                家族名
              </label>
              <input
                id="reg-family"
                className={styles.input}
                type="text"
                value={familyName}
                onChange={(e) => setFamilyName(e.target.value)}
                disabled={submitting}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="reg-pw">
                パスワード（英数字8文字以上）
              </label>
              <input
                id="reg-pw"
                className={styles.input}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
              />
            </div>
            {error ? (
              <p className={styles.error} role="alert">
                {error}
              </p>
            ) : null}
            <button
              type="submit"
              className={styles.submit}
              disabled={submitting}
            >
              {submitting ? "登録中…" : "登録してはじめる"}
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
