import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import styles from "../components/KakeiboDashboard.module.css";
import { UniversalImporter } from "../components/UniversalImporter";

export function ImportHubPage() {
  const navigate = useNavigate();
  const [msg, setMsg] = useState<string | null>(null);

  return (
    <div className={styles.wrap}>
      <h1 className={styles.title}>取込・入力ハブ</h1>
      <p className={styles.sub}>何でもここに置くだけで OK。形式はアプリが自動判別します。</p>

      <UniversalImporter
        onRoutedFiles={(list, kind) => {
          if (kind === "image") {
            setMsg("画像を検出しました。AIレシート解析へ移動します。");
            navigate("/receipt", { state: { prefillImportFile: list[0] } });
            return;
          }
          setMsg("CSV/PDF を検出しました。明細インポートへ移動します。");
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
          AIレシート詳細
        </Link>
      </p>
    </div>
  );
}
