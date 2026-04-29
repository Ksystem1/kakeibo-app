import { useRef, useState } from "react";
import styles from "./KakeiboDashboard.module.css";
import { isReceiptImageFile } from "../lib/importFileKind";

type RoutedKind = "image" | "statement";

type UniversalImporterProps = {
  onRoutedFiles: (files: File[], kind: RoutedKind) => void;
};

function isStatementFile(file: File): boolean {
  const n = (file.name || "").toLowerCase();
  return n.endsWith(".csv") || n.endsWith(".txt") || n.endsWith(".pdf");
}

export function UniversalImporter({ onRoutedFiles }: UniversalImporterProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  function routeFiles(files: FileList | File[]) {
    const list = Array.from(files ?? []);
    if (list.length === 0) return;
    const first = list[0];
    if (isReceiptImageFile(first)) {
      setHint(
        list.length > 1
          ? "先頭のレシート画像から取り込みを開始します。続きの枚数は写メ/ファイルから選ぶで追加できます。"
          : "画像を検出しました。AIレシート解析を開始します。",
      );
      onRoutedFiles(list, "image");
      return;
    }
    if (isStatementFile(first)) {
      setHint("CSV/PDF を検出しました。明細解析（文字コード判定込み）を開始します。");
      onRoutedFiles(list, "statement");
      return;
    }
    setHint("対応形式は JPG/PNG/CSV/TXT/PDF です。");
  }

  return (
    <div>
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
          routeFiles(e.dataTransfer.files);
        }}
        style={{
          marginTop: "0.75rem",
          borderRadius: 14,
          border: dragOver ? "2px dashed var(--accent)" : "1px dashed var(--border)",
          background: dragOver ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "var(--bg-card)",
          minHeight: "7.8rem",
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
            何でも置くだけ。形式はアプリが自動判別します。
          </p>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            style={{ marginTop: "0.7rem" }}
            onClick={() => inputRef.current?.click()}
          >
            + おまかせ取込
          </button>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.txt,.pdf,.tif,.tiff,image/*"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              const files = e.currentTarget.files;
              if (files && files.length > 0) routeFiles(files);
            }}
          />
        </div>
      </div>

      {hint ? (
        <p className={styles.sub} style={{ marginTop: "0.65rem", color: "var(--accent)" }}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
