import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { getTransactions, importCsvText } from "../lib/api";
import { FEATURE_EXPORT_CSV } from "../lib/api";
import { looksLikePayPayCsv, tryConvertBankCardCsvToKakeibo } from "../lib/bankCardCsvToKakeibo";
import {
  type ImportedStatementRow,
  duplicateKey,
  parseFinancialCsvText,
  parseFinancialPdfFile,
  toImportCsvText,
} from "../lib/financialStatementImport";
import { readFileTextAutoEncoding } from "../lib/fileTextDecode";
import styles from "../components/KakeiboDashboard.module.css";
import importStyles from "./ImportCsvPage.module.css";
import { useFeaturePermissions } from "../context/FeaturePermissionContext";

/**
 * 銀行・カード向けのレガシー形式 CSV（手書き行）取込。
 * PayPay 明細の取り込みは /receipt（レシート・明細取込）に集約。
 */
export function ImportCsvPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { allowedFor } = useFeaturePermissions();
  const canUseStatementImport = allowedFor(FEATURE_EXPORT_CSV);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [text, setText] = useState("");
  const [rows, setRows] = useState<
    Array<
      ImportedStatementRow & {
        include: boolean;
        duplicate: boolean;
        medical_checked: boolean;
        memo: string;
        category: string;
      }
    >
  >([]);
  const [dragOver, setDragOver] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [parsing, setParsing] = useState(false);

  useEffect(() => {
    const s = location.state;
    if (!s || typeof s !== "object") return;
    const maybeFiles = (s as { prefillFiles?: File[] }).prefillFiles;
    if (Array.isArray(maybeFiles) && maybeFiles.length > 0) {
      void parseFiles(maybeFiles);
      navigate(location.pathname, { replace: true, state: null });
      return;
    }
    const raw = (s as { paypayPrefillText?: string }).paypayPrefillText;
    if (typeof raw !== "string" || !raw.trim()) return;
    navigate("/receipt", { replace: true, state: { paypayPrefillText: raw } });
  }, [location.state, navigate, location.pathname]);

  const isDemoMode = useMemo(() => {
    const q = new URLSearchParams(location.search);
    return q.get("demo") === "1" || q.get("isDemoMode") === "1";
  }, [location.search]);

  async function applyDuplicateFlags(nextRows: ImportedStatementRow[]) {
    if (nextRows.length === 0) {
      setRows([]);
      return;
    }
    const dates = nextRows.map((r) => r.date).filter(Boolean).sort();
    const from = dates[0];
    const to = dates[dates.length - 1];
    const keySet = new Set<string>();
    try {
      const tx = await getTransactions(from, to, { scope: "family" });
      const items = Array.isArray(tx.items) ? tx.items : [];
      for (const t of items as Array<{ transaction_date?: string; amount?: number | string; memo?: string | null }>) {
        const d = String(t.transaction_date ?? "").slice(0, 10);
        const a = Math.round(Math.abs(Number(t.amount ?? 0)));
        const m = String(t.memo ?? "");
        if (d && a > 0) keySet.add(duplicateKey(d, a, m));
      }
    } catch {
      // 取得失敗時も取り込み操作は止めない
    }
    setRows(
      nextRows.map((r) => {
        const dup = keySet.has(duplicateKey(r.date, r.amount, r.description));
        return {
          ...r,
          include: !dup,
          duplicate: dup,
          medical_checked: r.medicalAuto,
          memo: r.description,
          category: r.categoryGuess,
        };
      }),
    );
  }

  async function parseFiles(files: FileList | File[]) {
    if (!canUseStatementImport) {
      setErr("CSV/PDF 取込はプレミアム限定機能です。設定画面からアップグレードできます。");
      return;
    }
    const list = Array.from(files ?? []);
    if (list.length === 0) return;
    setErr(null);
    setMsg(null);
    setParsing(true);
    try {
      const collected: ImportedStatementRow[] = [];
      for (const f of list) {
        const name = f.name.toLowerCase();
        if (name.endsWith(".pdf")) {
          const pdfRows = await parseFinancialPdfFile(f);
          collected.push(...pdfRows);
          continue;
        }
        if (name.endsWith(".csv") || name.endsWith(".txt")) {
          const decoded = await readFileTextAutoEncoding(f);
          const raw = decoded.text;
          if (looksLikePayPayCsv(raw)) {
            navigate("/receipt", { state: { paypayPrefillText: raw } });
            return;
          }
          const parsed = parseFinancialCsvText(raw, f.name);
          if (parsed.length > 0) {
            collected.push(...parsed);
            setText(raw);
            setMsg(
              `${f.name} を ${decoded.encoding === "shift_jis" ? "Shift-JIS" : "UTF-8"} として読み込みました。`,
            );
          } else {
            setText(raw);
          }
        }
      }
      await applyDuplicateFlags(collected);
      if (collected.length > 0) {
        setMsg(`${collected.length}件を読み込みました。保存前に修正できます。`);
      } else if (!text.trim()) {
        setMsg("明細行を抽出できませんでした。ヘッダー行（例: 利用日 / 内容 / 金額）を確認してください。");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setParsing(false);
    }
  }

  function loadDemoRows(kind: "epos" | "local-bank") {
    const base =
      kind === "epos"
        ? [
            "2026-04-01,エポスカード: イオンモール,3280",
            "2026-04-02,エポスカード: セブンイレブン,680",
            "2026-04-03,エポスカード: まつもと薬局,1420",
            "2026-04-04,エポスカード: JR東日本,1320",
            "2026-04-05,エポスカード: 〇〇クリニック,3600",
          ]
        : [
            "2026-04-06,〇〇信用金庫: 引落 電気料金,8400",
            "2026-04-07,〇〇銀行: スーパーA,2450",
            "2026-04-08,〇〇銀行: ドラッグストアB,1280",
            "2026-04-09,〇〇銀行: 市民病院,5200",
            "2026-04-10,〇〇銀行: ガソリンスタンド,4500",
          ];
    const parsed = base.map((line, i) => {
      const [date, description, amountRaw] = line.split(",");
      const amount = Number(amountRaw);
      return {
        id: `${kind}-${i}`,
        date,
        description,
        amount,
        source: kind === "epos" ? "Demo: EPOS" : "Demo: 地銀/信金",
        categoryGuess: description.includes("病院") || description.includes("薬局") ? "医療" : "未分類",
        medicalAuto: /病院|薬局|クリニック/.test(description),
      } satisfies ImportedStatementRow;
    });
    void applyDuplicateFlags(parsed);
    setMsg("デモ明細を読み込みました（MockDataのみ）。");
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setMsg(null);
    setLoading(true);
    try {
      if (!canUseStatementImport) {
        setErr("CSV取込はプレミアム限定です。");
        return;
      }
      if (rows.length > 0) {
        const selected = rows.filter((r) => r.include);
        if (selected.length === 0) {
          setMsg("取り込む対象がありません（すべて除外中）。");
          return;
        }
        const medicalSelected = selected.filter((r) => r.medical_checked).length;
        const csv = toImportCsvText(
          selected.map((r) => ({
            ...r,
            description: r.memo,
            categoryGuess: r.category,
            medicalAuto: r.medical_checked,
          })),
        );
        const r = await importCsvText(csv);
        setMsg(
          `保存完了: ${selected.length}件を取込候補から登録しました。追加 ${r.inserted}件。` +
            (medicalSelected > 0 ? ` 医療費関連 ${medicalSelected} 件は「医療費集計」画面で確認してください。` : ""),
        );
        setRows([]);
        setText("");
        return;
      }
      if (looksLikePayPayCsv(text)) {
        navigate("/receipt", { replace: false, state: { paypayPrefillText: text } });
        return;
      }
      let toSend = text;
      const bankConverted = tryConvertBankCardCsvToKakeibo(text);
      if (bankConverted) {
        toSend = bankConverted.text;
      } else {
        const parsed = parseFinancialCsvText(text, "貼り付けCSV");
        if (parsed.length > 0) {
          await applyDuplicateFlags(parsed);
          setMsg(`${parsed.length}件を解析しました。プレビューで確認後に保存してください。`);
          return;
        }
      }
      const r = await importCsvText(toSend);
      const created = r.categoriesCreated ?? 0;
      const deleted = r.deleted ?? 0;
      if (r.inserted > 0 || deleted > 0) {
        const parts: string[] = [];
        if (bankConverted) parts.push(bankConverted.message);
        parts.push(`支出を ${deleted} 件削除し、${r.inserted} 件追加しました。`);
        if (created > 0) parts.push(`新規カテゴリ ${created} 件を追加しました。`);
        if (r.message) parts.push(r.message);
        setMsg(parts.join(""));
      } else {
        if (bankConverted) {
          setMsg(
            bankConverted.text.trim()
              ? `${bankConverted.message} 取り込めた行はありません。`
              : (r.message ?? "取り込める行がありませんでした。"),
          );
        } else {
          setMsg(r.message ?? "取り込める行がありませんでした。");
        }
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
      {!canUseStatementImport ? (
        <div className={styles.settingsPanel} style={{ marginBottom: "0.9rem" }}>
          <p className={styles.sub} style={{ margin: 0 }}>
            この機能はプレミアム限定です。<Link to="/settings" style={{ color: "var(--accent)" }}>プランを確認する</Link>
          </p>
        </div>
      ) : null}
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
          void parseFiles(e.dataTransfer.files);
        }}
        style={{
          marginTop: "0.75rem",
          marginBottom: "0.75rem",
          border: dragOver ? "2px dashed var(--accent)" : "1px dashed var(--border)",
          background: dragOver ? "color-mix(in srgb, var(--accent) 10%, transparent)" : "var(--bg-card)",
        }}
      >
        <p className={styles.sub} style={{ margin: 0 }}>
          CSV/PDF をドラッグ&ドロップ、または
          <button
            type="button"
            className={`${styles.btn} ${styles.btnSm}`}
            style={{ marginLeft: "0.5rem" }}
            onClick={() => fileInputRef.current?.click()}
          >
            ファイルを選択
          </button>
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.txt,.pdf"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            const fs = e.currentTarget.files;
            if (fs && fs.length > 0) void parseFiles(fs);
          }}
        />
        {isDemoMode ? (
          <div style={{ marginTop: "0.65rem", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <button type="button" className={`${styles.btn} ${styles.btnSm}`} onClick={() => loadDemoRows("epos")}>
              サンプル: エポスカード
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSm}`}
              onClick={() => loadDemoRows("local-bank")}
            >
              サンプル: 地銀・信金
            </button>
          </div>
        ) : null}
        {parsing ? <p className={styles.sub} style={{ margin: "0.5rem 0 0" }}>解析中…</p> : null}
      </div>
      <div
        className={styles.settingsPanel}
        style={{
          marginTop: "0.75rem",
          marginBottom: "0.75rem",
          border: "1px solid color-mix(in srgb, var(--accent) 45%, transparent)",
          background: "color-mix(in srgb, var(--accent) 10%, transparent)",
        }}
      >
        <p className={styles.sub} style={{ margin: 0, lineHeight: 1.6, fontWeight: 600 }}>
          銀行等との接続（API ・自動取得）は行いません。口座明細の CSV は、各金融機関等が提供する書出し等の手順に従い
          ご利用者自身が取得した内容を、下の欄に貼り付けてください。
        </p>
        <p className={styles.sub} style={{ margin: "0.5rem 0 0", lineHeight: 1.6 }}>
          <Link to="/legal" style={{ color: "var(--accent)" }}>
            特商法・取り込み方針（よくある質問）
          </Link>
        </p>
      </div>
      {text.trim() || rows.length > 0 || msg ? (
        <div className={styles.settingsPanel} style={{ marginTop: 0, marginBottom: "0.9rem" }}>
          <p className={styles.sub} style={{ margin: 0, lineHeight: 1.55 }}>
            <strong>PayPay</strong> 明細は
            <Link to="/receipt" style={{ color: "var(--accent)", margin: "0 0.2rem" }}>
              レシート・明細取込
            </Link>
            へ。PayPay のログイン情報は当サービスに不要で、
            <strong> PayPay 公式アプリ等から書き出した CSV をアップロード</strong>してください。
          </p>
        </div>
      ) : null}
      <p className={styles.sub}>
        順: カテゴリ,日付,金額,メモ。対象月の支出を置き換え（収入はそのまま）。
      </p>
      <form onSubmit={onSubmit}>
        <textarea
          className={importStyles.textarea}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={14}
          placeholder="食費,2026-03-01,1200,イオン"
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
          disabled={loading || (!text.trim() && rows.length === 0)}
        >
          {loading ? "取込中…" : rows.length > 0 ? "この内容で保存" : "取り込む"}
        </button>
      </form>
      {rows.length > 0 ? (
        <div className={styles.tableWrap} style={{ marginTop: "1rem" }}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>取込</th>
                <th>日付</th>
                <th>内容</th>
                <th>金額</th>
                <th>カテゴリ</th>
                <th>医療費</th>
                <th>状態</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={r.include}
                      onChange={(e) =>
                        setRows((prev) => prev.map((x, idx) => (idx === i ? { ...x, include: e.target.checked } : x)))
                      }
                    />
                  </td>
                  <td>
                    <input
                      className={styles.cellInput}
                      type="date"
                      value={r.date}
                      onChange={(e) =>
                        setRows((prev) => prev.map((x, idx) => (idx === i ? { ...x, date: e.target.value } : x)))
                      }
                    />
                  </td>
                  <td>
                    <input
                      className={styles.cellInput}
                      type="text"
                      value={r.memo}
                      onChange={(e) =>
                        setRows((prev) => prev.map((x, idx) => (idx === i ? { ...x, memo: e.target.value } : x)))
                      }
                    />
                  </td>
                  <td>
                    <input
                      className={styles.cellInput}
                      type="number"
                      min={1}
                      value={r.amount}
                      onChange={(e) =>
                        setRows((prev) =>
                          prev.map((x, idx) => (idx === i ? { ...x, amount: Math.max(1, Number(e.target.value || 1)) } : x)),
                        )
                      }
                    />
                  </td>
                  <td>
                    <input
                      className={styles.cellInput}
                      type="text"
                      value={r.category}
                      onChange={(e) =>
                        setRows((prev) => prev.map((x, idx) => (idx === i ? { ...x, category: e.target.value } : x)))
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={r.medical_checked}
                      onChange={(e) =>
                        setRows((prev) =>
                          prev.map((x, idx) => (idx === i ? { ...x, medical_checked: e.target.checked } : x)),
                        )
                      }
                    />
                  </td>
                  <td>{r.duplicate ? "重複候補" : "新規候補"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
