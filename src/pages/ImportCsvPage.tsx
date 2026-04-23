import { FormEvent, useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { importCsvText } from "../lib/api";
import styles from "../components/KakeiboDashboard.module.css";

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
      <div className={styles.settingsPanel} style={{ marginTop: "0.75rem", marginBottom: "0.9rem" }}>
        <p className={styles.sub} style={{ margin: 0, lineHeight: 1.55 }}>
          PayPay 明細の取り込み（プレビュー・登録）は{" "}
          <Link to="/receipt" style={{ color: "var(--accent)" }}>
            レシート・明細取込
          </Link>{" "}
          に集約しています。ここでは、下記のカンマ区切りの旧形式のみ扱います。
        </p>
      </div>
      <p className={styles.sub}>
        カテゴリ,日付,金額,メモの順（カンマ区切り）。取込むと、CSVに現れる年月（YYYY-MM）ごとに、その月の既存の支出をいったん削除してから、行を追加します（収入は残ります）。
      </p>
      <form onSubmit={onSubmit}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={14}
          placeholder="食費,2026-03-01,1200,イオン（カテゴリが空の場合、未分類）"
          style={{
            width: "100%",
            fontFamily: "monospace",
            fontSize: "0.85rem",
            padding: "0.75rem",
            borderRadius: 10,
            border: "1px solid var(--border)",
            background: "rgba(0,0,0,0.25)",
            color: "var(--text)",
            marginBottom: "0.75rem",
          }}
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
