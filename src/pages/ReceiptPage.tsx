import { useState } from "react";
import { parseReceiptImage } from "../lib/api";
import styles from "../components/KakeiboDashboard.module.css";

export function ReceiptPage() {
  const [notice, setNotice] = useState<string | null>(null);
  const [items, setItems] = useState<
    Array<{ name: string; amount: number | null; confidence?: number }>
  >([]);
  const [apis, setApis] = useState<Record<string, string> | null>(null);
  const [loading, setLoading] = useState(false);

  async function onFile(f: File | null) {
    if (!f) return;
    setLoading(true);
    setNotice(null);
    setApis(null);
    try {
      const buf = await f.arrayBuffer();
      const b64 = btoa(
        new Uint8Array(buf).reduce((s, x) => s + String.fromCharCode(x), ""),
      );
      const r = await parseReceiptImage(b64);
      setItems(r.items ?? []);
      setApis(r.apis ?? null);
      setNotice(r.notice ?? null);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.wrap}>
      <h1 className={styles.title}>レシート読取（カメラ / 画像）</h1>
      <p className={styles.sub}>
        スマホではカメラで撮影して選択。本番では{" "}
        <strong>AWS Textract AnalyzeExpense</strong> 等で行単位を抽出します。
      </p>
      <input
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
        style={{ marginBottom: "1rem" }}
      />
      {loading ? <p>解析中…</p> : null}
      {notice ? (
        <p style={{ color: "var(--text-muted)", marginBottom: "1rem" }}>
          {notice}
        </p>
      ) : null}
      {apis ? (
        <ul
          style={{
            fontSize: "0.8rem",
            color: "var(--text-muted)",
            marginBottom: "1rem",
          }}
        >
          {Object.entries(apis).map(([k, v]) => (
            <li key={k}>
              <strong>{k}</strong>: {v}
            </li>
          ))}
        </ul>
      ) : null}
      <h2 className={styles.sectionTitle}>読取結果（デモ）</h2>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>品目</th>
              <th>金額</th>
              <th>信頼度</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={3}>
                  <div className={styles.empty}>画像を選択してください</div>
                </td>
              </tr>
            ) : (
              items.map((it, i) => (
                <tr key={i}>
                  <td>{it.name}</td>
                  <td>{it.amount != null ? `¥${it.amount}` : "—"}</td>
                  <td>{it.confidence != null ? it.confidence : "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
