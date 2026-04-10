import { FormEvent, useCallback, useEffect, useState } from "react";
import QRCode from "react-qr-code";
import { getFamilyMembers, inviteFamilyMember } from "../lib/api";
import styles from "../components/KakeiboDashboard.module.css";

export function MembersPage({ embedded = false }: { embedded?: boolean }) {
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
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [lineShareUrl, setLineShareUrl] = useState<string | null>(null);
  const [lineMessageShareUrl, setLineMessageShareUrl] = useState<string | null>(
    null,
  );
  const [inviteTargetEmail, setInviteTargetEmail] = useState<string | null>(null);
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
    const targetEmail = email.trim().toLowerCase();
    try {
      const r = await inviteFamilyMember(targetEmail);
      let m = r.message ?? "招待しました";
      if (r.debug_invite_token) {
        m += `（開発トークン: ${r.debug_invite_token}）`;
      }
      setMsg(m);
      const url = r.invite_url ?? null;
      setInviteUrl(url);
      setLineShareUrl(
        r.line_share_url ??
          (url
            ? `https://social-plugins.line.me/lineit/share?url=${encodeURIComponent(url)}`
            : null),
      );
      const lineTextFallback =
        url &&
        `https://line.me/R/msg/text/?${encodeURIComponent(
          [
            "【家計簿 Kakeibo】家族への招待です。",
            `登録時はこのメールアドレスを使ってください: ${targetEmail}`,
            url,
          ].join("\n"),
        )}`;
      setLineMessageShareUrl(r.line_message_share_url ?? lineTextFallback ?? null);
      setInviteTargetEmail(targetEmail);
      setEmail("");
      await load();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setLoading(false);
    }
  }

  const content = (
    <>
      {err ? (
        <p className={styles.err} role="alert">
          {err}
        </p>
      ) : null}
      {msg ? <p style={{ color: "var(--accent)" }}>{msg}</p> : null}
      {inviteUrl ? (
        <div
          style={{
            marginBottom: "1rem",
            padding: "0.85rem",
            border: "1px solid var(--border)",
            borderRadius: 10,
            background: "rgba(255,255,255,0.03)",
          }}
        >
          <p className={styles.sub} style={{ marginBottom: "0.55rem" }}>
            招待URL（メール・QR・LINE）
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", alignItems: "center" }}>
            <a
              href={inviteUrl}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--accent)", fontWeight: 600, textDecoration: "none" }}
            >
              招待URLを開く
            </a>
            <button
              type="button"
              className={styles.btn}
              onClick={async () => {
                await navigator.clipboard.writeText(inviteUrl);
                setMsg("招待URLをコピーしました");
              }}
            >
              URLをコピー
            </button>
            {inviteTargetEmail ? (
              <a
                href={`mailto:${inviteTargetEmail}?subject=${encodeURIComponent("家計簿への招待")}&body=${encodeURIComponent(
                  `以下のリンクから登録してください:\n${inviteUrl}`,
                )}`}
                className={styles.btn}
              >
                招待メールを作成
              </a>
            ) : null}
            {lineShareUrl ? (
              <a
                href={lineShareUrl}
                target="_blank"
                rel="noreferrer"
                className={`${styles.btn} ${styles.btnLine}`}
              >
                LINEで送る（リンク）
              </a>
            ) : null}
            {lineMessageShareUrl ? (
              <a
                href={lineMessageShareUrl}
                target="_blank"
                rel="noreferrer"
                className={`${styles.btn} ${styles.btnLine}`}
                style={{ opacity: 0.95 }}
              >
                LINEで送る（案内文付き）
              </a>
            ) : null}
            <div style={{ padding: 6, borderRadius: 8, background: "#fff", lineHeight: 0 }}>
              <QRCode value={inviteUrl} size={90} level="M" fgColor="#0f1419" bgColor="#ffffff" />
            </div>
          </div>
        </div>
      ) : null}

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

      <h2 className={styles.sectionTitle}>メールアドレスを登録して招待（LINE可）</h2>
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
    </>
  );

  if (embedded) return content;

  return (
    <div className={styles.wrap}>
      <h1 className={styles.title}>家族・利用ユーザー</h1>
      <p className={styles.sub}>
        同じ家族に紐づいた人は取引の入力・閲覧ができます。招待する方のメールアドレスを入力のうえ、URLをメール・QR・LINEで送れます（LINEはリンク共有または案内文付きのどちらでも可）。
      </p>
      {content}
    </div>
  );
}
