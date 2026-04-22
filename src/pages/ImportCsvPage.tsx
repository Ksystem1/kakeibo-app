import { FormEvent, useState } from "react";
import {
  commitPayPayCsvImport,
  importCsvText,
  previewPayPayCsvImport,
  type PayPayImportResult,
} from "../lib/api";
import styles from "../components/KakeiboDashboard.module.css";

const COMBINE_SAME_TIME_PAYMENTS_KEY = "combine_same_time_payments";
const PAYPAY_REQUIRED_HEADERS = ["取引日", "取引内容", "取引先", "取引番号"];

function looksLikePayPayCsv(text: string): boolean {
  const firstLine = String(text ?? "").split(/\r?\n/, 1)[0] ?? "";
  if (!firstLine.trim()) return false;
  return PAYPAY_REQUIRED_HEADERS.every((h) => firstLine.includes(h));
}

export function ImportCsvPage() {
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [paypayText, setPaypayText] = useState("");
  const [paypayErr, setPaypayErr] = useState<string | null>(null);
  const [paypayMsg, setPaypayMsg] = useState<string | null>(null);
  const [paypayLoading, setPaypayLoading] = useState(false);
  const [paypayPreview, setPaypayPreview] = useState<PayPayImportResult | null>(null);
  const [combineSameTimePayments, setCombineSameTimePayments] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COMBINE_SAME_TIME_PAYMENTS_KEY) === "1";
    } catch {
      return false;
    }
  });

  function onChangeCombineFlag(v: boolean) {
    setCombineSameTimePayments(v);
    try {
      localStorage.setItem(COMBINE_SAME_TIME_PAYMENTS_KEY, v ? "1" : "0");
    } catch {
      /* ignore */
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setMsg(null);
    setLoading(true);
    try {
      const r = await importCsvText(text);
      const created = r.categoriesCreated ?? 0;
      const deleted = r.deleted ?? 0;
      if (r.inserted > 0 || deleted > 0) {
        const parts = [
          `支出を ${deleted} 件削除し、${r.inserted} 件追加しました。`,
        ];
        if (created > 0) parts.push(`新規カテゴリ ${created} 件を追加しました。`);
        if (r.message) parts.push(r.message);
        setMsg(parts.join(""));
      } else {
        setMsg(r.message ?? "取り込める行がありませんでした。");
      }
      setText("");
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setLoading(false);
    }
  }

  async function onSelectPayPayFile(file: File) {
    const fileName = String(file?.name ?? "").trim();
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console -- デバッグ
      console.log("[ImportCsv] PayPay file", { name: fileName, size: file.size });
    }
    if (!fileName.toLowerCase().endsWith(".csv")) {
      setPaypayText("");
      setPaypayPreview(null);
      setPaypayMsg(null);
      setPaypayErr("PayPay取引CSVは拡張子 .csv のファイルを選んでください。");
      return;
    }
    const textContent = await file.text();
    if (!looksLikePayPayCsv(textContent)) {
      setPaypayText("");
      setPaypayPreview(null);
      setPaypayMsg(null);
      setPaypayErr(
        "選択したファイルはPayPay取引CSVの形式ではありません。CSVまたは拡張子なしの正しいPayPayデータを選択してください。",
      );
      return;
    }
    setPaypayText(textContent);
    setPaypayErr(null);
    setPaypayMsg(null);
    setPaypayPreview(null);
  }

  async function onPreviewPayPay() {
    setPaypayErr(null);
    setPaypayMsg(null);
    if (!looksLikePayPayCsv(paypayText)) {
      setPaypayErr(
        "PayPay CSVの形式を確認できませんでした。別ファイルを選ぶか、PayPayの取引CSV本文をそのまま貼り付けてください。",
      );
      return;
    }
    setPaypayLoading(true);
    try {
      const r = await previewPayPayCsvImport(paypayText, {
        combineSameTimePayments,
      });
      setPaypayPreview(r);
      setPaypayMsg(
        `プレビュー完了: 新規 ${r.newCount}件 / 更新 ${r.updatedCount}件 / 合算 ${r.aggregatedCount}件 / 除外 ${r.excludedCount}件`,
      );
    } catch (ex) {
      const m = ex instanceof Error ? ex.message : String(ex);
      setPaypayErr(
        /PayPay|必須列|CSV/.test(m)
          ? `${m} 別のファイルを選択してください。`
          : `PayPay CSV の読み取りに失敗しました。ファイル内容を確認し、別のファイルを選択してください。`,
      );
    } finally {
      setPaypayLoading(false);
    }
  }

  async function onCommitPayPay() {
    setPaypayErr(null);
    setPaypayMsg(null);
    if (!looksLikePayPayCsv(paypayText)) {
      setPaypayErr(
        "PayPay CSVの形式を確認できませんでした。別ファイルを選ぶか、PayPayの取引CSV本文をそのまま貼り付けてください。",
      );
      return;
    }
    setPaypayLoading(true);
    try {
      const r = await commitPayPayCsvImport(paypayText, {
        combineSameTimePayments,
      });
      setPaypayPreview(r);
      setPaypayMsg(
        `取込完了: 新規 ${r.newCount}件 / 更新 ${r.updatedCount}件 / 合算 ${r.aggregatedCount}件 / 除外 ${r.excludedCount}件`,
      );
    } catch (ex) {
      const m = ex instanceof Error ? ex.message : String(ex);
      setPaypayErr(
        /PayPay|必須列|CSV/.test(m)
          ? `${m} 別のファイルを選択してください。`
          : `PayPay CSV の取り込みに失敗しました。ファイル内容を確認し、別のファイルを選択してください。`,
      );
    } finally {
      setPaypayLoading(false);
    }
  }

  return (
    <div className={styles.wrap}>
      <h1 className={styles.title}>銀行・カード明細 CSV 取込</h1>
      <div className={styles.settingsPanel} style={{ marginTop: "0.9rem", marginBottom: "1rem" }}>
        <h2 className={styles.sectionTitle}>PayPay CSV 取込（プレビュー対応）</h2>
        <p className={styles.sub}>
          「取引内容=支払い」のみを取り込みます。取引番号で更新挿入し、同一ファイル再取込時は二重登録を避けます。
        </p>
        <div style={{ margin: "0.4rem 0 0.55rem" }}>
          <input
            type="file"
            accept=".csv, text/csv, text/plain, .txt"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              void onSelectPayPayFile(file);
            }}
          />
        </div>
        <p className={styles.reclassifyHint} style={{ margin: "0 0 0.45rem" }}>
          <code>accept</code> は iOS のファイルピッカー向けに広めに指定しています。取り込みは拡張子が .csv のファイルのみ（<code>file.type</code> は使いません）。形式は1行目で
          PayPay 取引 CSV か判定します。貼り付けは従来どおり利用できます。
        </p>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, marginBottom: "0.55rem" }}>
          <input
            type="checkbox"
            checked={combineSameTimePayments}
            onChange={(e) => onChangeCombineFlag(e.target.checked)}
          />
          combine_same_time_payments（同秒・同取引先の支払いを合算）
        </label>
        <textarea
          value={paypayText}
          onChange={(e) => {
            setPaypayText(e.target.value);
            setPaypayPreview(null);
          }}
          rows={12}
          placeholder="PayPay CSV を貼り付けるか、上のファイル選択を使ってください。"
          style={{
            width: "100%",
            fontFamily: "monospace",
            fontSize: "0.82rem",
            padding: "0.65rem",
            borderRadius: 10,
            border: "1px solid var(--border)",
            background: "rgba(0,0,0,0.25)",
            color: "var(--text)",
            marginBottom: "0.6rem",
          }}
        />
        {paypayErr ? (
          <p className={styles.err} role="alert">
            {paypayErr}
          </p>
        ) : null}
        {paypayMsg ? (
          <p style={{ color: "var(--accent)", marginBottom: "0.55rem" }}>{paypayMsg}</p>
        ) : null}
        {paypayPreview ? (
          <p className={styles.reclassifyHint} style={{ marginTop: "0.4rem" }}>
            対象行: {paypayPreview.totalRows} / 新規: {paypayPreview.newCount} / 更新:{" "}
            {paypayPreview.updatedCount} / 合算: {paypayPreview.aggregatedCount} / 除外:{" "}
            {paypayPreview.excludedCount} / エラー: {paypayPreview.errorCount}
          </p>
        ) : null}
        <div className={styles.modeRow} style={{ marginTop: "0.35rem", gap: "0.45rem" }}>
          <button
            type="button"
            className={styles.btn}
            disabled={paypayLoading || !paypayText.trim()}
            onClick={() => {
              void onPreviewPayPay();
            }}
          >
            {paypayLoading ? "確認中…" : "プレビュー"}
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={paypayLoading || !paypayText.trim()}
            onClick={() => {
              void onCommitPayPay();
            }}
          >
            {paypayLoading ? "取込中…" : "確定して取り込む"}
          </button>
        </div>
      </div>
      <p className={styles.sub}>
        カテゴリ,日付,金額,メモの順（カンマ区切り）。取込むと、CSVに現れる年月（YYYY-MM）ごとに、その月の既存の支出をいったん削除してから、行を追加します（収入は残ります）。
      </p>
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
