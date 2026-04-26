import { FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { LoginHeroSection } from "../components/LoginHeroSection";
import {
  getChildProfiles,
  loginRequest,
  normalizeAuthContextUser,
  normalizeFamilyRole,
  toFriendlyLoginErrorMessage,
} from "../lib/api";
import styles from "../components/LoginScreen.module.css";
import { MobileAccessQr } from "../components/MobileAccessQr";

function shouldLogAuthDebug() {
  return (
    Boolean(import.meta.env?.DEV) ||
    String(import.meta.env?.VITE_DEBUG_AUTH ?? "").trim() === "1"
  );
}

export function LoginPage() {
  const navigate = useNavigate();
  const { setSession, token } = useAuth();
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [demoExiting, setDemoExiting] = useState(false);

  useEffect(() => {
    if (!demoExiting) return;
    const id = window.setTimeout(() => {
      navigate("/demo-dashboard");
      setDemoExiting(false);
    }, 700);
    return () => {
      clearTimeout(id);
    };
  }, [demoExiting, navigate]);

  useEffect(() => {
    if (token) navigate("/", { replace: true });
  }, [token, navigate]);

  async function completeLogin(tokenValue: string, userValue: Awaited<ReturnType<typeof loginRequest>>["user"]) {
    const normalizedUser = normalizeAuthContextUser(userValue);
    if (shouldLogAuthDebug()) {
      // eslint-disable-next-line no-console
      console.info("[kakeibo:auth] login normalized user", normalizedUser);
    }
    setSession(tokenValue, normalizedUser);
    const role = normalizeFamilyRole(normalizedUser.familyRole);
    const canPickChildProfile = role === "ADMIN" || role === "MEMBER";
    if (canPickChildProfile) {
      try {
        const kids = await getChildProfiles();
        if (Array.isArray(kids.items) && kids.items.length > 0) {
          navigate("/child-select", { replace: true });
          return;
        }
      } catch {
        /* 子供プロフィール取得に失敗した場合は通常導線へ */
      }
    }
    navigate("/", { replace: true });
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmed = login.trim();
    if (!trimmed || !password) {
      setError("メールまたはログインIDとパスワードを入力してください。");
      return;
    }
    setSubmitting(true);
    try {
      const r = await loginRequest(trimmed, password);
      await completeLogin(r.token, r.user);
    } catch (err) {
      setError(toFriendlyLoginErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={`${styles.page}${demoExiting ? ` ${styles.pageDemoExit}` : ""}`}>
      {demoExiting ? <div className={styles.demoExitLayer} role="status" aria-live="assertive" aria-label="デモに移行中" /> : null}
      <LoginHeroSection onRequestDemoExit={() => setDemoExiting(true)} />
      <main className={styles.panel}>
        <div className={styles.card}>
          <header className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>ログイン</h2>
            <p className={styles.cardSub}>メールアドレス（またはログインID）とパスワード</p>
          </header>
          {error ? (
            <p className={styles.error} role="alert" style={{ margin: "0 0 0.9rem" }}>
              {error}
            </p>
          ) : null}
          <form className={styles.form} onSubmit={handleSubmit} noValidate>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="login-id">
                メールアドレスまたはログインID
              </label>
              <input
                id="login-id"
                className={styles.input}
                type="text"
                autoComplete="username"
                inputMode="email"
                autoCapitalize="none"
                autoCorrect="off"
                placeholder="例: あなた@example.com"
                value={login}
                onChange={(ev) => {
                  setLogin(ev.target.value);
                  if (error) setError(null);
                }}
                disabled={submitting}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="login-password">
                パスワード
              </label>
              <input
                id="login-password"
                className={styles.input}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(ev) => {
                  setPassword(ev.target.value);
                  if (error) setError(null);
                }}
                disabled={submitting}
              />
            </div>
            <div className={styles.row}>
              <label className={styles.checkbox}>
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(ev) => setRemember(ev.target.checked)}
                  disabled={submitting}
                />
                ログイン状態を保持する
              </label>
              <Link to="/forgot-password" className={styles.link}>
                パスワードをお忘れですか？
              </Link>
            </div>
            <button
              type="submit"
              className={styles.submit}
              disabled={submitting}
              style={{ marginTop: "0.15rem" }}
            >
              {submitting ? "サインイン中…" : "🔐 ログイン"}
            </button>
          </form>
          <p className={styles.footer}>
            はじめての方は{" "}
            <Link to="/register" className={styles.link}>
              新規登録
            </Link>
          </p>
          <p className={styles.footer} style={{ marginTop: "0.5rem" }}>
            <Link to="/legal" className={styles.link}>
              特商法の表記・取り込み方針（利用規約・よくある質問）
            </Link>
          </p>
          <aside className={styles.qrUnderFooter} aria-label="スマートフォンアクセス">
            <MobileAccessQr fixedPath={`${import.meta.env.BASE_URL}login`} />
          </aside>
        </div>
      </main>
    </div>
  );
}
