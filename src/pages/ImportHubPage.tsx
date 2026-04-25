import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import styles from "../components/KakeiboDashboard.module.css";
import { isReceiptImageFile } from "../lib/importFileKind";

function isStatementFile(file: File): boolean {
  const n = (file.name || "").toLowerCase();
  return n.endsWith(".csv") || n.endsWith(".txt") || n.endsWith(".pdf");
}

export function ImportHubPage() {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function routeFiles(files: FileList | File[]) {
    const list = Array.from(files ?? []);
    if (list.length === 0) return;
    const first = list[0];
    if (isReceiptImageFile(first)) {
      setMsg("画像を検出しました。AIレシート解析へ移動します。");
      navigate("/receipt", { state: { prefillImportFile: first } });
      return;
    }
    if (isStatementFile(first)) {
      setMsg("CSV/PDF を検出しました。明細インポートへ移動します。");
      navigate("/import/files", { state: { prefillFiles: list } });
      return;
    }
    setMsg("画像（jpg/png）または CSV/PDF を選択してください。");
  }

  return (
    <div className={styles.wrap}>
      <h1 className={styles.title}>取込・入力ハブ</h1>
      <p className={styles.sub}>何でもここに置くだけで OK。形式はアプリが自動判別します。</p>

      <div
        className={styles.settingsPanel}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void routeFiles(e.dataTransfer.files);
        }}
        style={{
          marginTop: "0.75rem",
          borderRadius: 14,
          border: dragOver ? "2px dashed var(--accent)" : "1px dashed var(--border)",
          background: dragOver ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "var(--bg-card)",
          minHeight: "7.5rem",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
        }}
      >
        <div>
          <p className={styles.sub} style={{ margin: 0, fontWeight: 700 }}>
            ファイルをここにドロップ
          </p>
          <p className={styles.sub} style={{ margin: "0.35rem 0 0" }}>
            JPG / PNG はレシート解析、CSV / PDF は明細取込へ自動振り分け
          </p>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            style={{ marginTop: "0.7rem" }}
            onClick={() => inputRef.current?.click()}
          >
            + 取込・入力
          </button>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.txt,.pdf,image/*"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              const files = e.currentTarget.files;
              if (files && files.length > 0) void routeFiles(files);
            }}
          />
        </div>
      </div>

      {msg ? (
        <p className={styles.sub} style={{ marginTop: "0.65rem", color: "var(--accent)" }}>
          {msg}
        </p>
      ) : null}

      <div
        style={{
          marginTop: "0.95rem",
          display: "grid",
          gap: "0.65rem",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
        }}
      >
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          style={{ minHeight: "3rem" }}
          onClick={() => navigate("/receipt")}
        >
          カメラで撮影（レシートAI）
        </button>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          style={{ minHeight: "3rem" }}
          onClick={() => navigate("/import/files")}
        >
          CSV/PDF を選択
        </button>
        <button
          type="button"
          className={styles.btn}
          style={{ minHeight: "3rem" }}
          onClick={() => navigate("/")}
        >
          手動で入力する
        </button>
      </div>

      <p className={styles.sub} style={{ marginTop: "0.95rem" }}>
        迷わない家計簿。取り込み口は、ひとつだけ。{" "}
        <Link to="/receipt" style={{ color: "var(--accent)" }}>
          詳細設定
        </Link>
      </p>
    </div>
  );
}
