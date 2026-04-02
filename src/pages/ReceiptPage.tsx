import { useEffect, useId, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createTransaction, parseReceiptImage } from "../lib/api";
import { useReceiptTouchUi } from "../hooks/useReceiptTouchUi";
import styles from "../components/KakeiboDashboard.module.css";

/** 日付入力（type=date）に載せられる形へ寄せる。無理ならテキストとして扱う */
function dateFieldMode(raw: string): { kind: "iso"; value: string } | { kind: "text"; value: string } {
  const s = raw.trim();
  if (!s) return { kind: "iso", value: "" };
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { kind: "iso", value: s };
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(s);
  if (m) {
    return {
      kind: "iso",
      value: `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`,
    };
  }
  const jp = /^(\d{4})年(\d{1,2})月(\d{1,2})日?$/.exec(s);
  if (jp) {
    return {
      kind: "iso",
      value: `${jp[1]}-${jp[2].padStart(2, "0")}-${jp[3].padStart(2, "0")}`,
    };
  }
  return { kind: "text", value: s };
}

export function ReceiptPage() {
  const touchUi = useReceiptTouchUi();
  const galleryInputId = useId();
  const vendorFieldId = useId();
  const totalFieldId = useId();
  const dateFieldId = useId();

  const navigate = useNavigate();

  const [notice, setNotice] = useState<string | null>(null);
  /** 解析結果を反映したうえでユーザーが修正可能 */
  const [draftVendor, setDraftVendor] = useState("");
  const [draftTotal, setDraftTotal] = useState("");
  const [draftDate, setDraftDate] = useState("");
  const [items, setItems] = useState<
    Array<{ name: string; amount: number | null; confidence?: number }>
  >([]);
  const [loading, setLoading] = useState(false);
  const [registering, setRegistering] = useState(false);

  useEffect(() => {
    if (!touchUi || !loading) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [touchUi, loading]);

  async function onFile(f: File | null) {
    if (!f) return;
    setLoading(true);
    setNotice(null);
    setDraftVendor("");
    setDraftTotal("");
    setDraftDate("");
    setItems([]);
    try {
      const buf = await f.arrayBuffer();
      const b64 = btoa(
        new Uint8Array(buf).reduce((s, x) => s + String.fromCharCode(x), ""),
      );
      const r = await parseReceiptImage(b64);
      setItems(r.items ?? []);
      const s = r.summary;
      setDraftVendor(s?.vendorName?.trim() ?? "");
      setDraftTotal(
        s?.totalAmount != null && Number.isFinite(Number(s.totalAmount))
          ? String(s.totalAmount)
          : "",
      );
      {
        const raw = s?.date?.trim() ?? "";
        const dm = dateFieldMode(raw);
        setDraftDate(dm.kind === "iso" ? dm.value : raw);
      }
      setNotice(r.notice ?? null);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    void onFile(e.target.files?.[0] ?? null);
    e.target.value = "";
  }

  const pickDisabled = loading ? styles.receiptPickBtnDisabled : "";

  const dateField = useMemo(() => dateFieldMode(draftDate), [draftDate]);

  const loadingUi = (
    <>
      {touchUi ? (
        <div
          className={styles.receiptLoadingOverlay}
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          <div className={styles.receiptLoadingOverlayInner}>
            <span className={styles.receiptSpinner} aria-hidden />
            <p className={styles.receiptLoadingOverlayText}>解析中...</p>
          </div>
        </div>
      ) : (
        <div
          className={styles.receiptLoadingPanel}
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          <span className={styles.receiptSpinner} aria-hidden />
          <span>解析中...</span>
        </div>
      )}
    </>
  );

  return (
    <div className={styles.wrap}>
      {loading ? loadingUi : null}
      <h1 className={styles.title}>レシート読取</h1>

      <p className={styles.sub}>
        レシート画像を選択すると、店舗名・合計・日付が自動入力されます。
        内容はいつでも修正できます。
      </p>
      {touchUi ? (
        <div className={styles.receiptPickRow}>
          <input
            id={galleryInputId}
            type="file"
            accept="image/*"
            className="visually-hidden"
            disabled={loading}
            onChange={handleFileChange}
          />
          <label
            htmlFor={galleryInputId}
            className={`${styles.receiptPickBtn} ${pickDisabled}`}
          >
            写真・ファイルを選ぶ
          </label>
        </div>
      ) : (
        <input
          type="file"
          accept="image/*"
          onChange={handleFileChange}
          disabled={loading}
          style={{ marginBottom: "1rem" }}
        />
      )}

      <form
        className={styles.receiptSummaryForm}
        onSubmit={(e) => e.preventDefault()}
      >
        <p className={styles.receiptSummaryHint}>
          {touchUi
            ? "内容確認"
            : "解析後、店舗名・合計・日付が下記に自動入力されます。内容はいつでも手で修正できます。"}
        </p>
        <div className={styles.field}>
          <label htmlFor={vendorFieldId}>店舗名</label>
          <input
            id={vendorFieldId}
            type="text"
            autoComplete="organization"
            placeholder="例: 〇〇ストア"
            value={draftVendor}
            onChange={(e) => setDraftVendor(e.target.value)}
            disabled={loading}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor={totalFieldId}>合計金額（円）</label>
          <input
            id={totalFieldId}
            type="text"
            inputMode="decimal"
            placeholder="例: 1234"
            value={draftTotal}
            onChange={(e) => setDraftTotal(e.target.value)}
            disabled={loading}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor={dateFieldId}>日付</label>
          {dateField.kind === "iso" ? (
            <input
              id={dateFieldId}
              type="date"
              value={dateField.value}
              onChange={(e) => setDraftDate(e.target.value)}
              disabled={loading}
            />
          ) : (
            <input
              id={dateFieldId}
              type="text"
              inputMode="numeric"
              placeholder="YYYY-MM-DD など"
              value={dateField.value}
              onChange={(e) => setDraftDate(e.target.value)}
              disabled={loading}
            />
          )}
        </div>

        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          disabled={
            loading ||
            registering ||
            !draftTotal.trim() ||
            dateField.kind !== "iso"
          }
          onClick={async () => {
            if (registering) return;
            setNotice(null);

            const amount = Number.parseFloat(draftTotal);
            if (!Number.isFinite(amount) || amount <= 0) {
              setNotice("金額を正しい数値で入力してください。");
              return;
            }
            if (dateField.kind !== "iso") {
              setNotice("日付は YYYY-MM-DD 形式にしてください。");
              return;
            }

            setRegistering(true);
            try {
              await createTransaction({
                kind: "expense",
                amount,
                transaction_date: dateField.value,
                memo: draftVendor.trim() || null,
                category_id: null,
              });
              navigate("/", { replace: true });
            } catch (e) {
              setNotice(e instanceof Error ? e.message : String(e));
            } finally {
              setRegistering(false);
            }
          }}
        >
          {registering ? "登録中…" : "登録"}
        </button>
      </form>

      {notice ? (
        <p style={{ color: "var(--text-muted)", marginBottom: "1rem" }}>
          {notice}
        </p>
      ) : null}

      {!touchUi ? (
        <>
          <h2 className={styles.sectionTitle}>読取結果（行）</h2>
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
        </>
      ) : null}
    </div>
  );
}
