import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import styles from "../components/KakeiboDashboard.module.css";
import { UniversalImporter } from "../components/UniversalImporter";
import { FEATURE_EXPORT_CSV } from "../lib/api";
import { useFeaturePermissions } from "../context/FeaturePermissionContext";

export function ImportHubPage() {
  const navigate = useNavigate();
  const { allowedFor, displayNameFor } = useFeaturePermissions();
  const canUseStatementImport = allowedFor(FEATURE_EXPORT_CSV);
  const csvFeatureLabel = displayNameFor(FEATURE_EXPORT_CSV);
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
            setMsg(
              `「${csvFeatureLabel}」は現在のプランではご利用いただけません。プランをご確認ください。`,
            );
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
            aria-labelledby="csv-paywall-title"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: "min(100%, 26rem)" }}
          >
            <div className={styles.upgradeModalHeader}>
              <h2 id="csv-paywall-title" className={styles.upgradeModalTitle}>
                {csvFeatureLabel}
              </h2>
              <span className={styles.upgradePremiumPill} aria-hidden>
                Premium
              </span>
            </div>
            <p className={styles.sub} style={{ marginBottom: "0.55rem" }}>
              <strong>プレミアム機能です。</strong>
              PayPayアプリなどから出力した利用履歴CSVをそのまま読み込み、スマホ決済の支出をまとめて反映できます。銀行・カードの明細CSVやPDFにも対応し、手入力や転記の手間を大きく減らせます。
            </p>
            <div className={styles.upgradeTrialPanel}>
              <span className={styles.upgradeTrialBadge}>3ヶ月無料お試し</span>
              <p className={styles.upgradeTrialLead}>
                はじめてプレミアムにご契約の場合、<strong>最大3ヶ月間の無料お試し</strong>が用意されていることがあります。
              </p>
              <p className={styles.upgradeTrialSub}>
                お申し込みは設定の「契約・プラン」から。無料お試しの有無・条件は、決済画面（Stripe）に表示される内容が優先されます。
              </p>
            </div>
            <p className={styles.sub} style={{ marginBottom: 0 }}>
              レシートAIでの撮影取込や手入力は、これまでどおりご利用いただけます。
            </p>
            <p className={styles.upgradeModalFootnote}>
              ※ キャンペーンや料金プランの変更により、無料期間が異なる場合があります。
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", justifyContent: "flex-end", marginTop: "0.95rem" }}>
              <button type="button" className={styles.btn} onClick={() => setShowUpgradeModal(false)}>
                閉じる
              </button>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                onClick={() => {
                  setShowUpgradeModal(false);
                  navigate("/settings");
                }}
              >
                プラン・無料お試しを確認
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
