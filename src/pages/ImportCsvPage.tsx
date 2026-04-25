import { FormEvent, useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { importCsvText } from "../lib/api";
import styles from "../components/KakeiboDashboard.module.css";
import importStyles from "./ImportCsvPage.module.css";

/**
 * 銀行・カード向けのレガシー形式 CSV（手書き行）取込。
 * PayPay 明細の取り込みは /receipt（レシート・明細取込）に集約。
 */
export function ImportCsvPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const s = location.state;
    if (!s || typeof s !== "object") return;
    const raw = (s as { paypayPrefillText?: string }).paypayPrefillText;
    if (typeof raw !== "string" || !raw.trim()) return;
    navigate("/receipt", { replace: true, state: { paypayPrefillText: raw } });
  }, [location.state, navigate]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setMsg(null);
    setLoading(true);
    try {
      const r = await importCsvText(text);
      const created = r.categoriesCreated ?? 0;
      const deleted = r.deleted ?? 0;
      if (r.inserted > 0 || deleted > 0) {
        const parts = [
          `支出を ${deleted} 件削除し、${r.inserted} 件追加しました。`,
        ];
        if (created > 0) parts.push(`新規カテゴリ ${created} 件を追加しました。`);
        if (r.message) parts.push(r.message);
        setMsg(parts.join(""));
      } else {
        setMsg(r.message ?? "取り込める行がありませんでした。");
      }
      setText("");
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.wrap}>
      <h1 className={styles.title}>銀行・カード明細 CSV 取込</h1>
      <div
        className={styles.settingsPanel}
        style={{
          marginTop: "0.75rem",
          marginBottom: "0.75rem",
          border: "1px solid color-mix(in srgb, var(--accent) 45%, transparent)",
          background: "color-mix(in srgb, var(--accent) 10%, transparent)",
        }}
      >
        <p className={styles.sub} style={{ margin: 0, lineHeight: 1.6, fontWeight: 600 }}>
          銀行等との接続（API ・自動取得）は行いません。口座明細の CSV は、各金融機関等が提供する書出し等の手順に従い
          ご利用者自身が取得した内容を、下の欄に貼り付けてください。
        </p>
        <p className={styles.sub} style={{ margin: "0.5rem 0 0", lineHeight: 1.6 }}>
          <Link to="/legal" style={{ color: "var(--accent)" }}>
            特商法・取り込み方針（よくある質問）
          </Link>
        </p>
      </div>
      <div className={styles.settingsPanel} style={{ marginTop: 0, marginBottom: "0.9rem" }}>
        <p className={styles.sub} style={{ margin: 0, lineHeight: 1.55 }}>
          <strong>PayPay</strong> 明細は
          <Link to="/receipt" style={{ color: "var(--accent)", margin: "0 0.2rem" }}>
            レシート・明細取込
          </Link>
          へ。PayPay のログイン情報は当サービスに不要で、
          <strong> PayPay 公式アプリ等から書き出した CSV をアップロード</strong>してください。
        </p>
      </div>
      <p className={styles.sub}>
        順: カテゴリ,日付,金額,メモ。対象月の支出を置き換え（収入はそのまま）。
      </p>
      <form onSubmit={onSubmit}>
        <textarea
          className={importStyles.textarea}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={14}
          placeholder="食費,2026-03-01,1200,イオン"
        />
        {err ? (
          <p className={styles.err} role="alert">
            {err}
          </p>
        ) : null}
        {msg ? (
          <p style={{ color: "var(--accent)", marginBottom: "0.75rem" }}>{msg}</p>
        ) : null}
        <button
          type="submit"
          className={`${styles.btn} ${styles.btnPrimary}`}
          disabled={loading || !text.trim()}
        >
          {loading ? "取込中…" : "取り込む"}
        </button>
      </form>
    </div>
  );
}
