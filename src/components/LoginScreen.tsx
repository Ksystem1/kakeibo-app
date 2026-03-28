import { FormEvent, useState } from "react";
import styles from "./LoginScreen.module.css";

/**
 * ログインは将来 AWS Amplify（`aws-amplify/auth`の signIn）と Cognito User Pool
 * に接続する想定です。メールエイリアス利用時も `username` にメール文字列を渡せます。
 * 「ログイン状態を保持」は `rememberDevice` やトークンストレージ方針と揃えてください。
 */
export function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const trimmed = email.trim();
    if (!trimmed || !password) {
      setError("メールアドレスとパスワードを入力してください。");
      return;
    }

    setSubmitting(true);
    try {
      // TODO: Amplify.configure(...) 後に signIn を呼び出す
      await new Promise((r) => setTimeout(r, 600));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.page}>
      <aside className={styles.hero} aria-hidden="false">
        <div className={styles.heroInner}>
          <span className={styles.badge}>Kakeibo</span>
          <h1 className={styles.heroTitle}>家計を静かに、確かに。</h1>
          <p className={styles.heroDesc}>
            収支の把握から振り返りまで。いまはローカルの入力体験のみですが、認証は
            Amazon Cognito 経由に切り替えられるよう準備しています。
          </p>
        </div>
      </aside>

      <main className={styles.panel}>
        <div className={styles.card}>
          <header className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>ログイン</h2>
            <p className={styles.cardSub}>
              登録済みのメールアドレスでサインインしてください。
            </p>
          </header>

          <form className={styles.form} onSubmit={handleSubmit} noValidate>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="login-email">
                メールアドレス
              </label>
              <input
                id="login-email"
                className={styles.input}
                type="email"
                name="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(ev) => setEmail(ev.target.value)}
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
                name="password"
                autoComplete="current-password"
                placeholder="••••••••"
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
              <button type="button" className={styles.link}>
                パスワードをお忘れですか？
              </button>
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
              {submitting ? "サインイン中…" : "ログイン"}
            </button>
          </form>

          <p className={styles.hint}>
            認証まわりは開発中です。リリース後は Amazon Cognito
            経由の安全なサインインに切り替わります。
          </p>

          <p className={styles.footer}>
            アカウントをお持ちでない方は{" "}
            <button type="button" className={styles.link}>
              新規登録
            </button>
          </p>
        </div>
      </main>
    </div>
  );
}
