import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import styles from "../components/KakeiboDashboard.module.css";
import { UniversalImporter } from "../components/UniversalImporter";
import { FEATURE_EXPORT_CSV } from "../lib/api";
import { useFeaturePermissions } from "../context/FeaturePermissionContext";

export function ImportHubPage() {
  const navigate = useNavigate();
  const { allowedFor } = useFeaturePermissions();
  const canUseStatementImport = allowedFor(FEATURE_EXPORT_CSV);
  const [msg, setMsg] = useState<string | null>(null);
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);

  return (
    <div className={styles.wrap}>
      <h1 className={styles.title}>おまかせ取込</h1>
      <p className={styles.sub}>レシート画像・CSV・PDFをここに置くだけ。形式を自動判別して取り込みます。</p>

      <UniversalImporter
        onRoutedFiles={(list, kind) => {
          if (kind === "image") {
            const prefillId =
              typeof globalThis !== "undefined" && globalThis.crypto?.randomUUID
                ? globalThis.crypto.randomUUID()
                : `pf-${Date.now()}-${String(Math.random()).slice(2)}`;
            if (list.length > 1) {
              setMsg(
                "複数の画像を検出したため、先頭1枚のレシート取込を始めます。他の画像は写メ/ファイルから選ぶで追加できます。",
              );
            } else {
              setMsg("画像を検出しました。AIレシート解析へ移動します。");
            }
            navigate("/receipt", {
              state: { prefillImportFile: list[0], prefillReceiptOnce: prefillId },
            });
            return;
          }
          if (!canUseStatementImport) {
            setShowUpgradeModal(true);
            setMsg("この取込は現在ご利用いただけません。設定からご契約内容をご確認ください。");
            return;
          }
          setMsg("CSV/PDF を検出しました。おまかせ解析を開始します。");
          navigate("/import/files", { state: { prefillFiles: list } });
        }}
      />

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
          onClick={() => {
            if (!canUseStatementImport) {
              setShowUpgradeModal(true);
              return;
            }
            navigate("/import/files");
          }}
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
          レシート取込へ
        </Link>
      </p>
      {showUpgradeModal ? (
        <div className={styles.categoryDetailBackdrop} role="presentation" onClick={() => setShowUpgradeModal(false)}>
          <div
            className={styles.categoryDetailDialog}
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className={styles.sectionTitle} style={{ marginTop: 0 }}>
              この取込について
            </h2>
            <p className={styles.sub}>
              銀行・カードの CSV/PDF 取込は、ご契約内容に応じてご利用いただけます。レシート画像の取込や手入力は引き続きご利用いただけます。
            </p>
            <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end", marginTop: "0.8rem" }}>
              <button type="button" className={styles.btn} onClick={() => setShowUpgradeModal(false)}>
                閉じる
              </button>
              <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => navigate("/settings")}>
                設定を開く
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
