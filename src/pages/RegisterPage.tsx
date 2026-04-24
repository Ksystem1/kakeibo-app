import { FormEvent, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { getPublicSettings, normalizeAuthContextUser, registerRequest } from "../lib/api";
import { AuthHeroAside } from "../components/AuthHeroAside";
import styles from "../components/LoginScreen.module.css";
import {
  isValidNewPassword,
  NEW_PASSWORD_ERROR_MESSAGE,
  NEW_PASSWORD_LABEL,
  NEW_PASSWORD_TOOLTIP,
} from "../lib/passwordPolicy";
const LOGIN_ID_RE = /^[a-zA-Z0-9]{1,15}$/;
// 漢字・ひらがな・カタカナ・英数字（最大長は useState 側で制御）
const NAME_RE = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z0-9]+$/u;
const DB_TEMP_MSG = "データベース接続が混み合っています。10秒ほど待って再試行してください。";

function isTemporaryDbError(message: string) {
  return /DatabaseUnavailable|getaddrinfo|EBUSY|一時的にデータベース/i.test(message);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function RegisterPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { setSession } = useAuth();
  const [email, setEmail] = useState("");
  const [loginName, setLoginName] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [monitorRecruitmentMessage, setMonitorRecruitmentMessage] = useState<string | null>(null);
  const inviteToken =
    searchParams.get("token")?.trim() || searchParams.get("invite")?.trim() || "";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await getPublicSettings();
        if (cancelled) return;
        if (s.is_monitor_mode && s.monitor_recruitment_text.trim() !== "") {
          setMonitorRecruitmentMessage(s.monitor_recruitment_text.trim());
        } else {
          setMonitorRecruitmentMessage(null);
        }
      } catch {
        if (!cancelled) setMonitorRecruitmentMessage(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccessMessage(null);
    const em = email.trim().toLowerCase();
    if (!em || !em.includes("@")) {
      setError("有効なメールアドレスを入力してください。");
      return;
    }
    if (!isValidNewPassword(password)) {
      setError(NEW_PASSWORD_ERROR_MESSAGE);
      return;
    }
    if (loginName && !LOGIN_ID_RE.test(loginName)) {
      setError("ログインIDは英数字のみ・最大15文字で入力してください。");
      return;
    }
    if (displayName && (!NAME_RE.test(displayName) || displayName.length > 10)) {
      setError("表示名は漢字・カナ・英数字のみ、最大10文字で入力してください。");
      return;
    }
    setSubmitting(true);
    try {
      let r:
        | Awaited<ReturnType<typeof registerRequest>>
        | null = null;
      const payload = {
        email: em,
        password,
        login_name: loginName.trim() || undefined,
        display_name: displayName.trim() || undefined,
        invite_token: inviteToken || undefined,
      };
      for (let i = 0; i < 3; i += 1) {
        try {
          if (i > 0) setRetrying(true);
          r = await registerRequest(payload);
          break;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (i < 2 && isTemporaryDbError(msg)) {
            await sleep(1200 * (i + 1));
            continue;
          }
          throw e;
        } finally {
          setRetrying(false);
        }
      }
      if (!r) {
        throw new Error("登録に失敗しました");
      }
      setSession(r.token, normalizeAuthContextUser(r.user));
      const monitorGranted = r.monitorGranted === true || r.user?.monitorGranted === true;
      if (monitorGranted) {
        setSuccessMessage("モニターとして登録されました。ご協力ありがとうございます！");
        await sleep(1400);
      }
      navigate("/", { replace: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "登録に失敗しました";
      setError(isTemporaryDbError(msg) ? DB_TEMP_MSG : msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.page}>
      <AuthHeroAside>
        <span className={styles.badge}>Kakeibo</span>
        <h1 className={styles.heroTitle}>はじめまして</h1>
        <p className={styles.heroDesc}>
          家族用の家計簿を作成します。
          <br />
          初期はご本人のみ。登録後に配偶者などを招待して共有できます。
        </p>
      </AuthHeroAside>
      <main className={styles.panel}>
        <div className={styles.card}>
          <header className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>新規登録</h2>
            <p className={styles.cardSub}>
              {inviteToken
                ? "招待リンクから登録します。あなたのメールアドレスとパスワードを設定してください。"
                : "メールとパスワードでアカウントを作成"}
            </p>
            <p className={styles.cardSub}>
              ログイン後の「設定」からパスキー（生体認証）を追加できます。
            </p>
          </header>
          {monitorRecruitmentMessage ? (
            <div
              className={styles.monitorRecruitmentCallout}
              role="status"
              aria-live="polite"
            >
              {monitorRecruitmentMessage}
            </div>
          ) : null}
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
                ログインID（任意・英数字のみ：最大15文字）
              </label>
              <input
                id="reg-login"
                className={styles.input}
                type="text"
                maxLength={15}
                value={loginName}
                onChange={(e) => setLoginName(e.target.value)}
                disabled={submitting}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="reg-name">
                表示名（任意・漢字・カナ・英数字：最大10文字）
              </label>
              <input
                id="reg-name"
                className={styles.input}
                type="text"
                maxLength={10}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                disabled={submitting}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="reg-pw" title={NEW_PASSWORD_TOOLTIP}>
                パスワード（{NEW_PASSWORD_LABEL}）
              </label>
              <input
                id="reg-pw"
                className={styles.input}
                type="password"
                autoComplete="new-password"
                title={NEW_PASSWORD_TOOLTIP}
                placeholder={`${NEW_PASSWORD_LABEL}（例: Abcdef1!）`}
                maxLength={128}
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
            {successMessage ? (
              <p className={styles.success} role="status" aria-live="polite">
                {successMessage}
              </p>
            ) : null}
            <button
              type="submit"
              className={styles.submit}
              disabled={submitting}
            >
              {submitting ? (retrying ? "接続再試行中…" : "登録中…") : "登録してはじめる"}
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
