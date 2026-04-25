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
            setMsg("画像を検出しました。AIレシート解析へ移動します。");
            navigate("/receipt", { state: { prefillImportFile: list[0] } });
            return;
          }
          if (!canUseStatementImport) {
            setShowUpgradeModal(true);
            setMsg("CSV/PDF 取込はプレミアム限定です。");
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
          AIレシート詳細
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
            <h2 className={styles.sectionTitle} style={{ marginTop: 0 }}>プレミアム限定機能</h2>
            <p className={styles.sub}>
              銀行・カードの CSV/PDF 取込はプレミアムでご利用いただけます。Standard ではレシートAIと手入力をご利用ください。
            </p>
            <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end", marginTop: "0.8rem" }}>
              <button type="button" className={styles.btn} onClick={() => setShowUpgradeModal(false)}>
                閉じる
              </button>
              <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => navigate("/settings")}>
                今すぐプレミアムを体験
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
