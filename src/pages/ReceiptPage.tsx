import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { useNavigate } from "react-router-dom";
import { createTransaction, getCategories, parseReceiptImage } from "../lib/api";
import { normalizeReceiptDateToYmd } from "../lib/receiptDate";
import { prepareReceiptImageForApi } from "../lib/receiptImage";
import { useReceiptTouchUi } from "../hooks/useReceiptTouchUi";
import styles from "../components/KakeiboDashboard.module.css";

/** 日付入力（type=date）に載せられる形へ寄せる。無理ならテキストとして扱う */
function dateFieldMode(raw: string): { kind: "iso"; value: string } | { kind: "text"; value: string } {
  const s = raw.trim();
  if (!s) return { kind: "iso", value: "" };
  const n = normalizeReceiptDateToYmd(s);
  if (n) return { kind: "iso", value: n };
  return { kind: "text", value: s };
}

type ExpenseCategory = { id: number; name: string; kind: "expense" | "income" };

const CATEGORY_TAGS = {
  food: ["食費", "食品", "食料品", "飲食", "スーパー", "グロサリー", "grocery", "food"],
  daily: ["日用品", "雑貨", "生活用品", "ドラッグ", "ドラッグストア"],
  transport: ["交通", "交通費", "電車", "バス", "タクシー", "ガソリン", "駐車場"],
  utility: ["水道", "光熱費", "電気", "ガス", "通信", "ネット", "携帯"],
  medical: ["医療", "病院", "薬", "薬局", "ドラッグ"],
  leisure: ["娯楽", "交際", "外食", "趣味", "レジャー"],
} as const;

const TAG_KEYWORDS = {
  food: [
    "りんご",
    "バナナ",
    "野菜",
    "肉",
    "魚",
    "牛乳",
    "卵",
    "パン",
    "米",
    "弁当",
    "飲料",
    "ジュース",
    "スーパー",
    "コンビニ",
  ],
  daily: ["ティッシュ", "洗剤", "シャンプー", "歯ブラシ", "トイレットペーパー", "日用品"],
  transport: ["電車", "バス", "タクシー", "駐車", "ガソリン", "高速", "ic"],
  utility: ["電気", "ガス", "水道", "通信", "wifi", "インターネット", "携帯"],
  medical: ["薬", "病院", "診療", "処方", "クリニック"],
  leisure: ["映画", "カフェ", "外食", "レジャー", "趣味", "書籍"],
} as const;

/** 店舗名に出やすい語（明細より店舗寄りでスコア） */
const VENDOR_TAG_HINTS: Record<string, readonly string[]> = {
  leisure: [
    "ディズニー",
    "ディズニーランド",
    "ディズニーシー",
    "ユニバーサル",
    "usj",
    "映画館",
    "シネマ",
    "イオンシネマ",
  ],
  food: [
    "セブンイレブン",
    "セブン",
    "ローソン",
    "ファミリーマート",
    "ファミマ",
    "イオン",
    "まいばすけっと",
    "マツキヨ",
    "マツモトキヨシ",
    "スターバックス",
    "スタバ",
    "マクドナルド",
    "マック",
    "すき家",
    "吉野家",
    "はま寿司",
    "スシロー",
    "くら寿司",
  ],
  daily: ["ダイソー", "セリア", "キャンドゥ", "無印"],
  transport: ["jr", "地下鉄", "メトロ", "モバイルsuica", "pasmo"],
};

function normalizeJa(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "").replace(/[　]/g, "");
}

function tagFromCategoryName(name: string): keyof typeof CATEGORY_TAGS | null {
  const n = normalizeJa(name);
  for (const [tag, aliases] of Object.entries(CATEGORY_TAGS) as Array<
    [keyof typeof CATEGORY_TAGS, readonly string[]]
  >) {
    if (aliases.some((a) => n.includes(normalizeJa(a)))) return tag;
  }
  return null;
}

function suggestExpenseCategoryId(
  categories: ExpenseCategory[],
  vendor: string,
  items: Array<{ name: string; amount: number | null; confidence?: number }>,
): number | null {
  if (categories.length === 0) return null;
  const vend = normalizeJa(vendor);
  const itemCorpus = normalizeJa(items.map((x) => x.name).join(" "));
  if (!vend && !itemCorpus) return null;
  const tagScore: Record<string, number> = {};
  for (const [tag, words] of Object.entries(TAG_KEYWORDS)) {
    let score = 0;
    for (const w of words) {
      const nw = normalizeJa(w);
      if (!nw) continue;
      if (itemCorpus.includes(nw)) score += 3;
      if (vend.includes(nw)) score += 1;
    }
    if (score > 0) tagScore[tag] = (tagScore[tag] ?? 0) + score;
  }
  for (const [tag, words] of Object.entries(VENDOR_TAG_HINTS)) {
    for (const w of words) {
      const nw = normalizeJa(w);
      if (nw && vend.includes(nw)) {
        tagScore[tag] = (tagScore[tag] ?? 0) + 4;
      }
    }
  }
  const ranked = categories
    .map((c) => {
      const tag = tagFromCategoryName(c.name);
      return {
        id: c.id,
        score: tag ? (tagScore[tag] ?? 0) : 0,
      };
    })
    .sort((a, b) => b.score - a.score);
  if (!ranked[0] || ranked[0].score <= 0) return null;
  return ranked[0].id;
}

/** モバイル「写真を選ぶ」: フォトライブラリ/ファイル優先（image/* は付けずにライブラリ寄りに絞る） */
const MOBILE_GALLERY_ACCEPT =
  "image/jpeg,image/jpg,image/png,image/heic,image/heif,image/webp,.heic,.heif";

export function ReceiptPage() {
  const touchUi = useReceiptTouchUi();
  const galleryInputId = useId();
  /** 写真ライブラリ / ファイル選択 */
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const [isIOS, setIsIOS] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);
  const vendorFieldId = useId();
  const totalFieldId = useId();
  const dateFieldId = useId();
  const memoFieldId = useId();

  const navigate = useNavigate();

  const [notice, setNotice] = useState<string | null>(null);
  /** 解析結果を反映したうえでユーザーが修正可能 */
  const [draftVendor, setDraftVendor] = useState("");
  const [draftMemo, setDraftMemo] = useState("");
  const [draftTotal, setDraftTotal] = useState("");
  const [draftDate, setDraftDate] = useState("");
  const [items, setItems] = useState<
    Array<{ name: string; amount: number | null; confidence?: number }>
  >([]);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [draftCategoryId, setDraftCategoryId] = useState<number | null>(null);
  const [categorySuggestSource, setCategorySuggestSource] = useState<
    "history" | "keywords" | null
  >(null);
  const [loading, setLoading] = useState(false);
  const [registering, setRegistering] = useState(false);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const r = await getCategories();
        const mapped = (r.items as Array<Record<string, unknown>>)
          .map((c) => ({
            id: Number(c.id),
            name: String(c.name ?? ""),
            kind: String(c.kind ?? "expense") as "expense" | "income",
          }))
          .filter((c) => Number.isFinite(c.id) && c.name && c.kind === "expense");
        if (!mounted) return;
        setCategories(mapped);
      } catch {
        if (!mounted) return;
        setCategories([]);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (draftCategoryId != null) return;
    if (!draftVendor && items.length === 0) return;
    const suggested = suggestExpenseCategoryId(categories, draftVendor, items);
    if (suggested != null) setDraftCategoryId(suggested);
  }, [categories, draftVendor, items, draftCategoryId]);

  useEffect(() => {
    if (!touchUi || !loading) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [touchUi, loading]);

  useEffect(() => {
    if (typeof navigator === "undefined") return;
    const ua = navigator.userAgent.toLowerCase();
    setIsIOS(/iphone|ipad|ipod/.test(ua));
    if (typeof window !== "undefined") {
      const standaloneByMedia = window.matchMedia?.("(display-mode: standalone)")?.matches ?? false;
      const standaloneByNavigator = Boolean(
        (window.navigator as Navigator & { standalone?: boolean }).standalone,
      );
      setIsStandalone(standaloneByMedia || standaloneByNavigator);
    }
  }, []);

  useEffect(() => {
    if (!isIOS) return;
    if (isStandalone) {
      setNotice(
        "ホーム画面に追加したアプリでは、OS の制限でアルバムの挙動が Safari と異なることがあります。問題があれば Safari で開くか、「写真を選ぶ」から既存の写真を選んでください。",
      );
    }
  }, [isIOS, isStandalone]);

  async function onFile(f: File | null) {
    if (!f) return;
    setLoading(true);
    setNotice(null);
    setDraftVendor("");
    setDraftMemo("");
    setDraftTotal("");
    setDraftDate("");
    setDraftCategoryId(null);
    setCategorySuggestSource(null);
    setItems([]);
    try {
      const b64 = await prepareReceiptImageForApi(f);
      const r = await parseReceiptImage(b64);
      setItems(r.items ?? []);
      const s = r.summary;
      const vendorTrim = s?.vendorName?.trim() ?? "";
      setDraftVendor(vendorTrim);
      setDraftMemo(vendorTrim);
      setDraftTotal(
        s?.totalAmount != null && Number.isFinite(Number(s.totalAmount))
          ? String(s.totalAmount)
          : "",
      );
      {
        const raw = s?.date?.trim() ?? "";
        const ymd = normalizeReceiptDateToYmd(raw) ?? raw;
        const dm = dateFieldMode(ymd);
        setDraftDate(dm.kind === "iso" ? dm.value : ymd);
      }
      const localSuggested = suggestExpenseCategoryId(
        categories,
        s?.vendorName?.trim() ?? "",
        r.items ?? [],
      );
      setDraftCategoryId(r.suggestedCategoryId ?? localSuggested);
      setCategorySuggestSource(
        r.suggestedCategorySource ??
          (r.suggestedCategoryId == null && localSuggested != null ? "keywords" : null),
      );
      setNotice(r.notice ?? null);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
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
        レシート画像を選ぶと、店舗名・合計金額・日付・カテゴリを自動で推定します（明細のキーワードと店舗名を優先）。
        合計欄が読み取れない場合は明細から推定することがあります。
      </p>
      {/* file input は flex 行の外に置き、一部モバイル WebView でレイアウトに影響しないようにする */}
      {touchUi ? (
        <input
          key="receipt-gallery-mobile"
          ref={galleryInputRef}
          id={galleryInputId}
          type="file"
          accept={MOBILE_GALLERY_ACCEPT}
          multiple={false}
          className="visually-hidden"
          disabled={loading}
          onChange={handleFileChange}
          tabIndex={-1}
          aria-hidden
        />
      ) : (
        <input
          key="receipt-gallery-pc"
          ref={galleryInputRef}
          id={galleryInputId}
          type="file"
          accept="image/*"
          className="visually-hidden"
          disabled={loading}
          onChange={handleFileChange}
          tabIndex={-1}
          aria-hidden
        />
      )}
      <div className={styles.receiptPickRow}>
        <button
          type="button"
          className={`${styles.receiptPickBtn} ${styles.receiptPickBtnPrimary} ${pickDisabled}`}
          onClick={() => {
            setNotice(null);
            galleryInputRef.current?.click();
          }}
          disabled={loading}
        >
          写真を選ぶ
        </button>
      </div>

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
        <div className={`${styles.field} ${styles.receiptMemoField}`}>
          <label htmlFor={memoFieldId}>メモ</label>
          <input
            id={memoFieldId}
            type="text"
            autoComplete="off"
            placeholder="店舗名など（解析時に自動入力されます）"
            value={draftMemo}
            onChange={(e) => setDraftMemo(e.target.value)}
            disabled={loading}
          />
        </div>
        <div className={styles.field}>
          <label>カテゴリ</label>
          <select
            value={draftCategoryId ?? ""}
            onChange={(e) =>
              setDraftCategoryId(e.target.value ? Number(e.target.value) : null)
            }
            disabled={loading}
          >
            <option value="">未分類</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {draftCategoryId != null && categorySuggestSource ? (
            <small className={styles.receiptSummaryHint}>
              {categorySuggestSource === "history"
                ? "過去の登録履歴から自動分類しました。必要なら変更できます。"
                : "店舗名と明細のキーワードからカテゴリを推定しました。必要なら変更できます。"}
            </small>
          ) : null}
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
                memo: (draftMemo.trim() || draftVendor.trim()) || null,
                category_id: draftCategoryId,
              });
              const month = dateField.value.slice(0, 7);
              navigate(`/?month=${encodeURIComponent(month)}`, { replace: true });
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
        <p className={styles.infoText} style={{ marginBottom: "1rem" }}>
          {notice}
        </p>
      ) : null}

      {!touchUi && items.length === 0 ? (
        <p className={styles.sub}>画像を選択すると、合計金額を自動で反映します。</p>
      ) : null}
    </div>
  );
}
