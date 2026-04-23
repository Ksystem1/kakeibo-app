import { useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import {
  getPasskeyRegistrationOptions,
  normalizeAuthContextUser,
  verifyPasskeyRegistration,
} from "../lib/api";
import { AuthHeroAside } from "../components/AuthHeroAside";
import styles from "../components/LoginScreen.module.css";

export function PasskeyRegisterPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { setSession } = useAuth();
  const [displayName, setDisplayName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const inviteToken = searchParams.get("invite")?.trim() || "";
  const inviteMode = inviteToken !== "";

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
      const m = e instanceof Error ? e.message : String(e);
      setError(m || "パスキー登録に失敗しました");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.page}>
      <AuthHeroAside>
        <span className={styles.badge}>Kakeibo</span>
        <h1 className={styles.heroTitle}>パスキーではじめる</h1>
        <p className={styles.heroDesc}>
          メールアドレス不要で、指紋・顔認証だけで登録できます。
        </p>
      </AuthHeroAside>
      <main className={styles.panel}>
        <div className={styles.card}>
          <header className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>{inviteMode ? "家族に参加" : "パスキー新規登録"}</h2>
            <p className={styles.cardSub}>
              {inviteMode
                ? "招待リンクから参加します。パスキーを登録してください。"
                : "この端末のパスキーを作成してアカウントを作成します。"}
            </p>
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
              {submitting ? "パスキー登録中…" : inviteMode ? "パスキーを登録して参加" : "パスキーで登録"}
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
