import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getFamilyMembers, getTransactions, type MedicalType } from "../lib/api";
import styles from "../components/KakeiboDashboard.module.css";

type TxMedical = {
  id: number;
  transaction_date: string;
  amount: number | string;
  memo: string | null;
  is_medical_expense?: number | boolean;
  medical_type?: MedicalType | null;
  medical_patient_name?: string | null;
};

type MedicalSummaryRow = {
  patientName: string;
  payee: string;
  medicalType: MedicalType;
  amount: number;
};

const MEDICAL_TYPE_LABELS: Record<MedicalType, string> = {
  treatment: "診療・治療",
  medicine: "医薬品",
  other: "その他",
};

function yearRange(year: number) {
  return {
    from: `${year}-01-01`,
    to: `${year}-12-31`,
  };
}

function parseAmount(v: number | string): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

function escapeCsvCell(raw: string): string {
  const v = String(raw ?? "");
  if (/[",\r\n]/.test(v)) return `"${v.replace(/"/g, "\"\"")}"`;
  return v;
}

function buildCsv(rows: MedicalSummaryRow[]): string {
  const header = ["氏名", "支払先", "区分", "金額"];
  const lines = rows.map((r) =>
    [
      escapeCsvCell(r.patientName),
      escapeCsvCell(r.payee),
      escapeCsvCell(MEDICAL_TYPE_LABELS[r.medicalType]),
      escapeCsvCell(String(r.amount)),
    ].join(","),
  );
  return [header.join(","), ...lines].join("\r\n");
}

function downloadCsvUtf8Bom(csvText: string, filename: string) {
  const blob = new Blob(["\uFEFF", csvText], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Windows ファイル名に使えない文字を除く */
function sanitizeFileNameSegment(s: string): string {
  const t = String(s ?? "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return t || "家族";
}

export function MedicalDeductionPage() {
  const now = new Date();
  const [year, setYear] = useState<number>(now.getFullYear());
  const [rows, setRows] = useState<MedicalSummaryRow[]>([]);
  /** 画面表示用（未サニタイズ可） */
  const [familyLabel, setFamilyLabel] = useState("家族");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const { from, to } = yearRange(year);
        const [txRes, fmRes] = await Promise.all([getTransactions(from, to, { scope: "family" }), getFamilyMembers()]);
        const txItems = (txRes.items ?? []) as TxMedical[];
        const aggregated = new Map<string, MedicalSummaryRow>();
        for (const tx of txItems) {
          const isMedical = tx.is_medical_expense === true || Number(tx.is_medical_expense) === 1;
          if (!isMedical) continue;
          const mt = tx.medical_type;
          if (mt !== "treatment" && mt !== "medicine" && mt !== "other") continue;
          const patientName = String(tx.medical_patient_name ?? "").trim() || "本人";
          const payee = String(tx.memo ?? "").trim() || "不明";
          const amount = Math.max(0, parseAmount(tx.amount));
          if (amount <= 0) continue;
          const key = `${patientName}\t${payee}\t${mt}`;
          const prev = aggregated.get(key);
          if (prev) {
            prev.amount += amount;
          } else {
            aggregated.set(key, { patientName, payee, medicalType: mt, amount });
          }
        }
        const nextRows = [...aggregated.values()].sort((a, b) => {
          if (a.patientName !== b.patientName) return a.patientName.localeCompare(b.patientName, "ja");
          if (a.payee !== b.payee) return a.payee.localeCompare(b.payee, "ja");
          if (a.medicalType !== b.medicalType) return a.medicalType.localeCompare(b.medicalType);
          return a.amount - b.amount;
        });
        if (cancelled) return;
        setRows(nextRows);
        const rawName = String(fmRes.familyName ?? "").trim();
        if (rawName) {
          setFamilyLabel(rawName);
        } else {
          const fid = Number(fmRes.familyId);
          setFamilyLabel(
            Number.isFinite(fid) && fid > 0 ? `家族${fid}` : "家族",
          );
        }
      } catch (e) {
        if (cancelled) return;
        setRows([]);
        setError(e instanceof Error ? e.message : "医療費集計の取得に失敗しました");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [year]);

  const totalAmount = useMemo(
    () => rows.reduce((acc, r) => acc + Number(r.amount || 0), 0),
    [rows],
  );

  const exportFilename = `医療費控除明細_${year}年度_${sanitizeFileNameSegment(familyLabel)}.csv`;

  return (
    <div className={styles.wrap}>
      <div style={{ marginBottom: "0.65rem" }}>
        <Link to="/settings" style={{ color: "var(--text-muted)", fontSize: "0.9rem" }}>
          ← 設定へ戻る
        </Link>
      </div>
      <h1 className={styles.title}>医療費集計</h1>
      <p className={styles.sub}>
        1月1日〜12月31日の医療費控除対象データを集計して、国税庁の医療費集計フォーム向けCSVを出力できます。
      </p>

      {error ? (
        <p className={styles.err} role="alert">
          {error}
        </p>
      ) : null}

      <div className={styles.settingsPanel} style={{ marginBottom: "1rem", maxWidth: 840 }}>
        <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", alignItems: "end" }}>
          <label className={styles.field} style={{ minWidth: 180 }}>
            <span>対象年（1月〜12月）</span>
            <input
              type="number"
              className={styles.monthInput}
              min={2000}
              max={2100}
              value={year}
              onChange={(e) => setYear(Number(e.target.value || now.getFullYear()))}
            />
          </label>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            style={{ fontSize: "1rem", padding: "0.72rem 1.15rem" }}
            disabled={loading || rows.length === 0}
            onClick={() => downloadCsvUtf8Bom(buildCsv(rows), exportFilename)}
            title="BOM付きUTF-8で出力します（Windows Excel向け）"
          >
            CSVで書き出す
          </button>
          <span className={styles.sub} style={{ margin: 0 }}>
            {loading ? "集計中…" : `${rows.length}件 / 合計 ${totalAmount.toLocaleString("ja-JP")}円`}
          </span>
        </div>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>氏名</th>
              <th>支払先</th>
              <th>区分</th>
              <th>金額</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4}>
                  <div className={styles.empty}>
                    {loading ? "読み込み中…" : "対象年の医療費控除データはありません。"}
                  </div>
                </td>
              </tr>
            ) : (
              rows.map((r, i) => (
                <tr key={`${r.patientName}-${r.payee}-${r.medicalType}-${i}`}>
                  <td>{r.patientName}</td>
                  <td>{r.payee}</td>
                  <td>{MEDICAL_TYPE_LABELS[r.medicalType]}</td>
                  <td>{r.amount.toLocaleString("ja-JP")}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
