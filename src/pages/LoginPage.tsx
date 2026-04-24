import { FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { startAuthentication } from "@simplewebauthn/browser";
import { useAuth } from "../context/AuthContext";
import { AuthHeroAside } from "../components/AuthHeroAside";
import {
  getChildProfiles,
  getPasskeyLoginOptions,
  loginRequest,
  loginWithRecoveryCode,
  normalizeAuthContextUser,
  normalizeFamilyRole,
  toFriendlyPasskeyErrorMessage,
  verifyPasskeyLogin,
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
  const [passkeySubmitting, setPasskeySubmitting] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [error, setError] = useState<string | null>(null);

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

  async function startPasskeyLogin() {
    if (passkeySubmitting) return;
    setError(null);
    setPasskeySubmitting(true);
    try {
      const opt = await getPasskeyLoginOptions();
      const credential = await startAuthentication({
        optionsJSON: opt.options as Parameters<typeof startAuthentication>[0]["optionsJSON"],
        useBrowserAutofill: false,
      });
      const r = await verifyPasskeyLogin({
        flow_token: opt.flowToken,
        credential,
      });
      await completeLogin(r.token, r.user);
    } catch (e) {
      const msg = toFriendlyPasskeyErrorMessage(e);
      setError(
        msg
          ? `${msg} お手数ですが、下の「メールまたはログインID」と「パスワード」でログインしてください。`
          : "パスキーでログインできませんでした。下のメール（またはログインID）とパスワードでお試しください。",
      );
    } finally {
      setPasskeySubmitting(false);
    }
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
      setError(err instanceof Error ? err.message : "ログインに失敗しました");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.page}>
      <AuthHeroAside>
        <span className={styles.badge}>Kakeibo ✨</span>
        <h1 className={styles.heroTitle}>みんなの家計簿</h1>
        <p className={styles.heroDesc}>家計簿を共有できます。</p>
        <Link to="/demo-dashboard" className={styles.demoCta}>
          🎬 デモを見る
        </Link>
      </AuthHeroAside>
      <main className={styles.panel}>
        <div className={styles.card}>
          <header className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>ログイン</h2>
            <p className={styles.cardSub}>登録したメールまたは子ども用のログインIDでサインイン</p>
          </header>
          <form className={styles.form} onSubmit={handleSubmit} noValidate>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="login-id">
                メールまたはログインID
              </label>
              <input
                id="login-id"
                className={styles.input}
                type="text"
                autoComplete="username"
                placeholder="you@example.com"
                value={login}
                onChange={(ev) => setLogin(ev.target.value)}
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
                onChange={(ev) => setPassword(ev.target.value)}
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
            {error ? (
              <p className={styles.error} role="alert">
                {error}
              </p>
            ) : null}
            <button type="submit" className={styles.submit} disabled={submitting || passkeySubmitting}>
              {submitting ? "サインイン中…" : "🔐 ログイン"}
            </button>
            <p className={styles.cardSub} style={{ margin: "0.75rem 0 0", fontSize: "0.88rem", opacity: 0.9 }}>
              次の方法（任意）
            </p>
            <button
              type="button"
              className={styles.btn}
              disabled={passkeySubmitting || submitting}
              onClick={() => {
                void startPasskeyLogin();
              }}
            >
              {passkeySubmitting ? "パスキー認証中…" : "パスキーでログイン"}
            </button>
            <p className={styles.cardSub} style={{ margin: "0.5rem 0 0", fontSize: "0.8rem", opacity: 0.85 }}>
              先に設定でパスキーを登録した方のみ。うまくいかない場合は上のメール＋パスワードをご利用ください。
            </p>
            <div className={styles.field} style={{ marginTop: "0.9rem" }}>
              <label className={styles.label} htmlFor="recovery-code">
                リカバリーコード（デバイス紛失時）
              </label>
              <div className={styles.row}>
                <input
                  id="recovery-code"
                  className={styles.input}
                  type="text"
                  placeholder="XXXX-XXXX-XXXX-XXXX"
                  value={recoveryCode}
                  onChange={(ev) => setRecoveryCode(ev.target.value)}
                  disabled={submitting || passkeySubmitting}
                />
                <button
                  type="button"
                  className={styles.btn}
                  disabled={submitting || passkeySubmitting || recoveryCode.trim() === ""}
                  onClick={async () => {
                    setError(null);
                    setSubmitting(true);
                    try {
                      const r = await loginWithRecoveryCode(recoveryCode);
                      setRecoveryCode("");
                      await completeLogin(r.token, r.user);
                    } catch (e) {
                      setError(e instanceof Error ? e.message : String(e));
                    } finally {
                      setSubmitting(false);
                    }
                  }}
                >
                  コードでログイン
                </button>
              </div>
            </div>
          </form>
          <p className={styles.footer}>
            はじめての方は{" "}
            <Link to="/register" className={styles.link}>
              新規登録（メール＋パスワード）
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
