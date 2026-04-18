import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  createTransaction,
  getCategories,
  parseReceiptImage,
  saveReceiptOcrCorrection,
} from "../lib/api";
import { isReservedLedgerFixedCostCategoryName } from "../lib/transactionCategories";
import { normalizeReceiptDateToYmd } from "../lib/receiptDate";
import { prepareReceiptImageForApi } from "../lib/receiptImage";
import { getReceiptDebugTier } from "../lib/receiptDebugTier";
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

function todayYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
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

function pickCategoryIdByName(
  categories: ExpenseCategory[],
  suggestedName: string | null | undefined,
): number | null {
  const target = normalizeJa(String(suggestedName ?? "").trim());
  if (!target) return null;
  const exact = categories.find((c) => normalizeJa(c.name) === target);
  if (exact) return exact.id;
  const partial = categories.find((c) => {
    const nm = normalizeJa(c.name);
    return nm.includes(target) || target.includes(nm);
  });
  return partial ? partial.id : null;
}

/** モバイル「レシート取込」: フォトライブラリ/ファイル優先（image/* は付けずにライブラリ寄りに絞る） */
const MOBILE_GALLERY_ACCEPT =
  "image/jpeg,image/jpg,image/png,image/heic,image/heif,image/webp,.heic,.heif";

export function ReceiptPage() {
  const touchUi = useReceiptTouchUi();
  const galleryInputId = useId();
  /** 写真ライブラリ / ファイル選択 */
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const [isIOS, setIsIOS] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);
  const totalFieldId = useId();
  const kindFieldId = useId();
  const dateFieldId = useId();
  const memoFieldId = useId();
  const categoryFieldId = useId();

  const navigate = useNavigate();

  const [notice, setNotice] = useState<string | null>(null);
  /** OCR の店舗名（カテゴリ推定用・画面上は非表示） */
  const [ocrVendor, setOcrVendor] = useState("");
  const [draftMemo, setDraftMemo] = useState("");
  const [draftTotal, setDraftTotal] = useState("");
  const [draftDate, setDraftDate] = useState("");
  const [items, setItems] = useState<
    Array<{ name: string; amount: number | null; confidence?: number }>
  >([]);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [draftCategoryId, setDraftCategoryId] = useState<number | null>(null);
  const [categorySuggestSource, setCategorySuggestSource] = useState<
    "history" | "keywords" | "correction" | "ai" | null
  >(null);
  /** プレミアム: 解析 API が返す合計の候補（匿名辞書・明細合算など） */
  const [totalCandidates, setTotalCandidates] = useState<
    Array<{ total: number; label: string; source: string }>
  >([]);
  const [lastParsePremium, setLastParsePremium] = useState(false);
  const [receiptDictionaryHits, setReceiptDictionaryHits] = useState(0);
  const showTotalCandidateChips = useMemo(
    () =>
      lastParsePremium &&
      (totalCandidates.length >= 2 ||
        totalCandidates.some((c) => c.source === "global" || c.source === "lines")),
    [lastParsePremium, totalCandidates],
  );
  /** 登録時に POST /receipts/learn へ送る直近の取込スナップショット */
  const [lastOcrForLearn, setLastOcrForLearn] = useState<{
    summary: Record<string, unknown>;
    items: Array<{ name: string; amount: number | null; confidence?: number }>;
  } | null>(null);
  /** 解析直後にフォームへ入れたメモ（店名）・カテゴリ・金額。差分があれば学習する */
  const [loadedReceiptBaseline, setLoadedReceiptBaseline] = useState<{
    memo: string;
    categoryId: number | null;
    totalAmount: number | null;
  } | null>(null);
  /** true のときはカテゴリ変更をユーザー操作とみなし、baseline を自動追従しない */
  const categoryTouchedByUserRef = useRef(false);
  const [loading, setLoading] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [receiptDebugTier, setReceiptDebugTierState] = useState(() =>
    getReceiptDebugTier(),
  );

  useEffect(() => {
    const sync = () => setReceiptDebugTierState(getReceiptDebugTier());
    window.addEventListener("kakeibo-receipt-debug-tier", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("kakeibo-receipt-debug-tier", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

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
          .filter(
            (c) =>
              Number.isFinite(c.id) &&
              c.name &&
              c.kind === "expense" &&
              !isReservedLedgerFixedCostCategoryName(c.name),
          );
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
    if (!ocrVendor && items.length === 0) return;
    const suggested = suggestExpenseCategoryId(categories, ocrVendor, items);
    if (suggested != null) setDraftCategoryId(suggested);
  }, [categories, ocrVendor, items, draftCategoryId]);

  /** 解析時は categories が遅れて届くと keyword 提案が後から入る。baseline.categoryId が null のままだと誤学習するため、ユーザー未操作時だけ追従する */
  useEffect(() => {
    setLoadedReceiptBaseline((b) => {
      if (!b) return b;
      if (categoryTouchedByUserRef.current) return b;
      if (b.categoryId != null) return b;
      if (draftCategoryId == null) return b;
      return { ...b, categoryId: draftCategoryId };
    });
  }, [draftCategoryId]);

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
        "ホーム画面に追加したアプリでは、OS の制限でアルバムの挙動が Safari と異なることがあります。問題があれば Safari で開くか、「レシート取込」から既存の写真を選んでください。",
      );
    }
  }, [isIOS, isStandalone]);

  async function onFile(f: File | null) {
    if (!f) return;
    setLoading(true);
    setNotice(null);
    setOcrVendor("");
    setDraftMemo("");
    setDraftTotal("");
    setDraftDate("");
    setDraftCategoryId(null);
    setCategorySuggestSource(null);
    setTotalCandidates([]);
    setLastParsePremium(false);
    setReceiptDictionaryHits(0);
    setItems([]);
    setLastOcrForLearn(null);
    setLoadedReceiptBaseline(null);
    categoryTouchedByUserRef.current = false;
    try {
      const b64 = await prepareReceiptImageForApi(f);
      const r = await parseReceiptImage(b64, {
        debugForceReceiptTier: receiptDebugTier,
      });
      setTotalCandidates(Array.isArray(r.totalCandidates) ? r.totalCandidates : []);
      setLastParsePremium(r.subscriptionActive === true);
      setReceiptDictionaryHits(
        typeof r.receiptGlobalDictionaryHitCount === "number"
          ? r.receiptGlobalDictionaryHitCount
          : 0,
      );
      setItems(r.items ?? []);
      const s = r.summary;
      if (s && typeof s === "object") {
        setLastOcrForLearn({
          summary: s as Record<string, unknown>,
          items: r.items ?? [],
        });
      } else {
        setLastOcrForLearn(null);
      }
      const vendorTrim = s?.vendorName?.trim() ?? "";
      setOcrVendor(vendorTrim);
      if (r.learnCorrectionHit && r.suggestedMemo !== undefined) {
        setDraftMemo(r.suggestedMemo);
      } else {
        setDraftMemo(vendorTrim);
      }
      setDraftTotal(
        s?.totalAmount != null && Number.isFinite(Number(s.totalAmount))
          ? String(s.totalAmount)
          : "",
      );
      {
        const raw = s?.date?.trim() ?? "";
        const ymd = normalizeReceiptDateToYmd(raw) ?? raw;
        const dm = dateFieldMode(ymd);
        if (dm.kind === "iso" && dm.value) {
          setDraftDate(dm.value);
        } else {
          setDraftDate(todayYmd());
          setNotice("日付を読み取れなかったため、本日の日付を仮入力しました。必要なら変更してください。");
        }
      }
      const localSuggested = suggestExpenseCategoryId(
        categories,
        s?.vendorName?.trim() ?? "",
        r.items ?? [],
      );
      const aiNameMatchedId =
        r.suggestedCategoryId == null
          ? pickCategoryIdByName(categories, r.suggestedCategoryName)
          : null;
      const initialCategoryId =
        r.suggestedCategoryId ?? aiNameMatchedId ?? localSuggested ?? null;
      setDraftCategoryId(initialCategoryId);
      setCategorySuggestSource(
        r.suggestedCategorySource ??
          (r.suggestedCategoryId == null && aiNameMatchedId == null && localSuggested != null
            ? "keywords"
            : null),
      );
      const initialMemo =
        r.learnCorrectionHit && r.suggestedMemo !== undefined
          ? String(r.suggestedMemo).trim()
          : vendorTrim;
      setLoadedReceiptBaseline({
        memo: initialMemo,
        categoryId: initialCategoryId,
        totalAmount:
          s?.totalAmount != null && Number.isFinite(Number(s.totalAmount))
            ? Math.round(Number(s.totalAmount))
            : null,
      });
      {
        const parts: string[] = [];
        if (r.receiptAdvancedParsingBanner) parts.push(r.receiptAdvancedParsingBanner);
        if (r.receiptAdvancedParsingMessages?.length) {
          parts.push(r.receiptAdvancedParsingMessages.join(" "));
        }
        if (r.duplicateWarning) parts.push(r.duplicateWarning);
        if (r.notice) parts.push(r.notice);
        setNotice(parts.length ? parts.join(" ") : null);
      }
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
      setItems([]);
      setLastParsePremium(false);
      setReceiptDictionaryHits(0);
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
      {receiptDebugTier !== "server" ? (
        <p
          className={styles.infoText}
          style={{ marginTop: "0.35rem", maxWidth: 640 }}
        >
          開発: レシートAIは「
          {receiptDebugTier === "free" ? "無料（厳密）" : "有料（履歴ヒントあり）"}
          」プロンプトを強制中。設定画面のボタンで切り替えられます。
        </p>
      ) : null}

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
          レシート取込
        </button>
      </div>

      <form
        className={styles.form}
        data-receipt-form
        onSubmit={(e) => e.preventDefault()}
      >
        <p
          className={`${styles.receiptSummaryHint} ${styles.receiptFormBanner}`}
        >
          {touchUi
            ? "内容確認"
            : "解析後、合計・日付・メモ（店舗名が取れた場合はここ）が下記に自動入力されます。内容はいつでも手で修正できます。"}
        </p>
        {categorySuggestSource ? (
          <p className={styles.receiptSummaryHint} style={{ marginTop: "-0.2rem" }}>
            {categorySuggestSource === "history"
              ? "過去履歴から自動反映しました（必要なら変更できます）。"
              : categorySuggestSource === "correction"
                ? "過去の補正内容を反映しました（必要なら変更できます）。"
                : categorySuggestSource === "ai"
                  ? "AIがカテゴリを予測して自動反映しました（必要なら変更できます）。"
                : "カテゴリ候補を自動提案しました（必要なら変更できます）。"}
          </p>
        ) : null}
        <div className={`${styles.field} ${styles.receiptFieldKind}`}>
          <label htmlFor={kindFieldId}>種別</label>
          <select id={kindFieldId} value="expense" disabled aria-readonly>
            <option value="expense">支出</option>
          </select>
        </div>
        <div className={`${styles.field} ${styles.receiptFieldCategory}`}>
          <label htmlFor={categoryFieldId}>カテゴリ</label>
          <select
            id={categoryFieldId}
            value={draftCategoryId ?? ""}
            onChange={(e) => {
              categoryTouchedByUserRef.current = true;
              setDraftCategoryId(e.target.value ? Number(e.target.value) : null);
            }}
            disabled={loading}
          >
            <option value="">なし</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {categorySuggestSource ? <small className={styles.receiptCategoryHint}>自動候補</small> : null}
        </div>
        <div className={`${styles.field} ${styles.receiptFieldDate}`}>
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
        <div className={`${styles.field} ${styles.receiptFieldAmount}`}>
          <label htmlFor={totalFieldId}>金額</label>
          <input
            id={totalFieldId}
            type="text"
            inputMode="decimal"
            placeholder="1200"
            value={draftTotal}
            onChange={(e) => setDraftTotal(e.target.value)}
            disabled={loading}
          />
        </div>
        {showTotalCandidateChips ? (
          <div
            className={`${styles.field} ${styles.receiptFieldAmount}`}
            style={{ gridColumn: "1 / -1" }}
          >
            <span className={styles.sub} style={{ display: "block", marginBottom: "0.35rem" }}>
              合計の候補（プレミアム）
              {receiptDictionaryHits > 0 ? (
                <span style={{ marginLeft: "0.35rem", opacity: 0.85 }}>
                  · 匿名辞書 {receiptDictionaryHits} 件一致
                </span>
              ) : null}
            </span>
            <div className={styles.modeRow} style={{ flexWrap: "wrap", gap: "0.35rem" }}>
              {totalCandidates.map((c, idx) => (
                <button
                  key={`${c.source}-${c.total}-${idx}`}
                  type="button"
                  className={styles.btn}
                  disabled={loading}
                  onClick={() => setDraftTotal(String(c.total))}
                  title={c.label}
                >
                  ¥{c.total.toLocaleString("ja-JP")}
                  <span className={styles.sub} style={{ marginLeft: "0.25rem", fontSize: "0.82em" }}>
                    {c.source === "global"
                      ? "辞書"
                      : c.source === "lines"
                        ? "明細"
                        : "解析"}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <div
          className={`${styles.field} ${styles.receiptMemoField} ${styles.receiptFieldMemo}`}
        >
          <label htmlFor={memoFieldId}>メモ</label>
          <input
            id={memoFieldId}
            type="text"
            autoComplete="off"
            placeholder="内容"
            value={draftMemo}
            onChange={(e) => setDraftMemo(e.target.value)}
            disabled={loading}
          />
        </div>

        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary} ${styles.receiptFormSubmit}`}
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
                memo: draftMemo.trim() || null,
                category_id: draftCategoryId,
                from_receipt: true,
              });
              if (lastOcrForLearn?.summary && loadedReceiptBaseline) {
                const submittedMemo = draftMemo.trim();
                const submittedCat = draftCategoryId ?? null;
                const submittedTotal = Number.isFinite(amount) ? Math.round(amount) : null;
                const memoChanged = submittedMemo !== loadedReceiptBaseline.memo;
                const categoryChanged = submittedCat !== loadedReceiptBaseline.categoryId;
                const totalChanged = submittedTotal !== loadedReceiptBaseline.totalAmount;
                if (memoChanged || categoryChanged || totalChanged) {
                  void saveReceiptOcrCorrection({
                    summary: lastOcrForLearn.summary,
                    items: lastOcrForLearn.items,
                    category_id: draftCategoryId,
                    memo: submittedMemo || null,
                    confirmed_total_amount: amount,
                    confirmed_date: dateField.value,
                  }).catch(() => {});
                }
              }
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
