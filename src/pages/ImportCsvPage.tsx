import { FormEvent, useState } from "react";
import { importCsvText } from "../lib/api";
import { useIsMobile } from "../hooks/useIsMobile";
import styles from "../components/KakeiboDashboard.module.css";

export function ImportCsvPage() {
  const mobile = useIsMobile();
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setMsg(null);
    setLoading(true);
    try {
      const r = await importCsvText(text);
      const created = r.categoriesCreated ?? 0;
      setMsg(
        `${r.inserted} 件取り込み。${created > 0 ? `新規カテゴリ ${created} 件を追加しました。` : ""}${r.message ?? ""}`,
      );
      setText("");
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setLoading(false);
    }
  }

  if (mobile) {
    return (
      <div className={styles.wrap}>
        <p className={styles.empty}>
          CSV 取込は画面幅の広いPC向けにしています。パソコンで開くか、メニューから家計簿へ。
        </p>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <h1 className={styles.title}>銀行・カード明細 CSV 取込</h1>
      <p className={styles.sub}>カテゴリ,日付,金額,メモの順（カンマ区切り）。</p>
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
