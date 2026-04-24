import { useEffect, useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import {
  getPasskeyRegistrationOptions,
  normalizeAuthContextUser,
  toFriendlyPasskeyErrorMessage,
  verifyPasskeyRegistration,
} from "../lib/api";
import { AuthHeroAside } from "../components/AuthHeroAside";
import styles from "../components/LoginScreen.module.css";

const ALLOW_DEV =
  typeof import.meta.env !== "undefined" && String(import.meta.env.VITE_ALLOW_PASSKEY_STANDALONE ?? "") === "1";

export function PasskeyRegisterPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { setSession } = useAuth();
  const [displayName, setDisplayName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const inviteToken = searchParams.get("token")?.trim() || searchParams.get("invite")?.trim() || "";
  const inviteMode = inviteToken !== "";

  useEffect(() => {
    if (inviteMode) {
      navigate(`/register?token=${encodeURIComponent(inviteToken)}`, { replace: true });
    }
  }, [inviteMode, inviteToken, navigate]);

  async function onStartPasskey() {
    setError(null);
    setMsg(null);
    setSubmitting(true);
    try {
      const opt = await getPasskeyRegistrationOptions({
        display_name: displayName.trim() || undefined,
        invite_token: inviteToken || undefined,
      });
      const credential = await startRegistration({
        optionsJSON: opt.options as Parameters<typeof startRegistration>[0]["optionsJSON"],
      });
      const r = await verifyPasskeyRegistration({
        flow_token: opt.flowToken,
        credential,
      });
      setSession(r.token, normalizeAuthContextUser(r.user));
      setRecoveryCode(r.recoveryCode ?? null);
      setMsg("パスキー登録が完了しました。バックアップコードを保存してください。");
    } catch (e) {
      const m = toFriendlyPasskeyErrorMessage(e);
      setError(m || "パスキー登録に失敗しました");
    } finally {
      setSubmitting(false);
    }
  }

  if (inviteMode) {
    return (
      <div className={styles.page}>
        <AuthHeroAside>
          <span className={styles.badge}>Kakeibo</span>
          <h1 className={styles.heroTitle}>招待から登録</h1>
          <p className={styles.heroDesc}>メール＋パスワード登録に移動しています…</p>
        </AuthHeroAside>
        <main className={styles.panel}>
          <p className={styles.cardSub}>少々お待ちください</p>
        </main>
      </div>
    );
  }

  if (!ALLOW_DEV) {
    return (
      <div className={styles.page}>
        <AuthHeroAside>
          <span className={styles.badge}>Kakeibo</span>
          <h1 className={styles.heroTitle}>新規登録</h1>
          <p className={styles.heroDesc}>
            新規の方はメールアドレスとパスワードで登録してください。パスキーはログイン後の「設定」で追加し、次回以降のログインに使えます。
          </p>
        </AuthHeroAside>
        <main className={styles.panel}>
          <div className={styles.card}>
            <header className={styles.cardHeader}>
              <h2 className={styles.cardTitle}>メール＋パスワードで新規登録</h2>
            </header>
            <p className={styles.cardSub} style={{ marginTop: 0 }}>
              パスキーだけの新規登録は、不正利用防止のため提供していません。
            </p>
            <p className={styles.footer}>
              <Link to="/register" className={styles.link}>
                新規登録フォームへ
              </Link>
              {" / "}
              <Link to="/login" className={styles.link}>
                ログイン
              </Link>
            </p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <AuthHeroAside>
        <span className={styles.badge}>Kakeibo / dev</span>
        <h1 className={styles.heroTitle}>パスキーではじめる（検証用）</h1>
        <p className={styles.heroDesc}>
          開発時のみ。本番では <code style={{ fontSize: "0.8rem" }}>VITE_ALLOW_PASSKEY_STANDALONE=1</code> かつ
          サーバ ALLOW_PASSKEY_STANDALONE_REGISTER=1
        </p>
      </AuthHeroAside>
      <main className={styles.panel}>
        <div className={styles.card}>
          <header className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>パスキー新規登録</h2>
            <p className={styles.cardSub}>この端末のパスキーを作成してアカウントを作成します。</p>
          </header>
          <div className={styles.form}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="pk-name">
                表示名（任意）
              </label>
              <input
                id="pk-name"
                className={styles.input}
                type="text"
                maxLength={100}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                disabled={submitting}
                placeholder="例: たろう"
              />
            </div>
            {error ? (
              <p className={styles.error} role="alert">
                {error}
              </p>
            ) : null}
            {msg ? (
              <p className={styles.success} role="status">
                {msg}
              </p>
            ) : null}
            {recoveryCode ? (
              <div className={styles.monitorRecruitmentCallout}>
                <strong>バックアップコード（16桁）</strong>
                <div style={{ marginTop: "0.35rem", fontSize: "1.05rem", letterSpacing: "0.08em" }}>
                  {recoveryCode}
                </div>
                <div style={{ marginTop: "0.35rem", fontSize: "0.86rem" }}>
                  デバイス紛失時に必要です。安全な場所に保存してください。
                </div>
              </div>
            ) : null}
            <button
              type="button"
              className={styles.submit}
              disabled={submitting}
              onClick={() => {
                void onStartPasskey();
              }}
            >
              {submitting ? "パスキー登録中…" : "パスキーで登録"}
            </button>
            {recoveryCode ? (
              <button
                type="button"
                className={styles.btn}
                onClick={() => {
                  navigate("/", { replace: true });
                }}
              >
                保存したので続行
              </button>
            ) : null}
          </div>
          <p className={styles.footer}>
            <Link to="/login" className={styles.link}>
              既存ログインへ
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
