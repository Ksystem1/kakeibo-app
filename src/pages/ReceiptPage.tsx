import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  commitPayPayCsvImport,
  createTransaction,
  FEATURE_RECEIPT_AI,
  getCategories,
  type ParseReceiptResult,
  type ReceiptAsyncJobStatus,
  uploadReceiptForAsyncJob,
  previewPayPayCsvImport,
  savePlaceCategoryPreference,
  saveReceiptOcrCorrection,
  resolveReceiptSuggestedVendor,
  type PayPayImportResult,
} from "../lib/api";
import { FeatureGate } from "../components/FeatureGate";
import { isReservedLedgerFixedCostCategoryName } from "../lib/transactionCategories";
import { normalizeReceiptDateToYmd } from "../lib/receiptDate";
import { compressReceiptFileToJpegBlob } from "../lib/receiptImage";
import { ReceiptRegionRescanPanel } from "../components/ReceiptRegionRescanPanel";
import { getReceiptDebugTier } from "../lib/receiptDebugTier";
import { looksLikePayPayCsv } from "../lib/paypayCsv";
import { UNIFIED_IMPORT_ACCEPT, isCsvFileName, isReceiptImageFile, isTxtFileName } from "../lib/importFileKind";
import { useReceiptJob, type ReceiptImportQueueItem } from "../hooks/useReceiptJob";
import { formatReceiptQueueFailureMessage } from "../lib/receiptJobResult";
import { useReceiptTouchUi } from "../hooks/useReceiptTouchUi";
import styles from "../components/KakeiboDashboard.module.css";

/** 取込フォーム: 自動推定の確信度が低いセル向け（オレンジ枠＋title） */
const RECEIPT_AI_INFERENCE_HINT = "自動で読み取った内容です。必要に応じて修正してください。";

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
type ReceiptItemCategory =
  | "食費"
  | "日用品"
  | "衣類"
  | "娯楽"
  | "医療"
  | "教育"
  | "交通費"
  | "その他";
const RECEIPT_ITEM_CATEGORIES: ReceiptItemCategory[] = [
  "食費",
  "日用品",
  "衣類",
  "娯楽",
  "医療",
  "教育",
  "交通費",
  "その他",
];

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

function isGenericPaymentMemo(raw: string): boolean {
  const s = normalizeJa(raw);
  if (!s) return false;
  return /(クレジット|カード|決済|支払|支払い|現金|電子マネー|paypay|visa|master|jcb)/i.test(s);
}

function pickReceiptMemo(params: {
  suggestedMemo?: string | null;
  suggestedStoreName?: string | null;
  vendorName?: string | null;
}): string {
  const store = String(params.suggestedStoreName ?? "").trim();
  if (store) return store;
  const vendor = String(params.vendorName ?? "").trim();
  if (vendor && !isGenericPaymentMemo(vendor)) return vendor;
  const memo = String(params.suggestedMemo ?? "").trim();
  if (memo && !isGenericPaymentMemo(memo)) return memo;
  return store || vendor || memo;
}

function pickInitialTotalAmount(
  summaryTotal: unknown,
  items: Array<{ amount: number | null }>,
  totalCandidates: Array<{ total: number; source: string }>,
): string {
  const parsedTotal = Number(summaryTotal);
  const initialTotal =
    Number.isFinite(parsedTotal) && parsedTotal > 0 ? Math.round(parsedTotal) : null;
  const lineSum = Math.round(
    items.reduce(
      (acc, it) => acc + (Number.isFinite(Number(it.amount)) ? Math.max(0, Number(it.amount)) : 0),
      0,
    ),
  );
  const candidateTotals = totalCandidates
    .map((c) => Math.round(Number(c.total)))
    .filter((n) => Number.isFinite(n) && n > 0);
  const bestLineLike =
    candidateTotals.find(
      (n) => lineSum > 0 && Math.abs(n - lineSum) <= Math.max(10, Math.round(lineSum * 0.05)),
    ) ?? null;

  // 典型: OCR の桁落ち（15100 -> 1510）。明細合計や候補が明確に大きい場合はそちらを優先。
  if (initialTotal != null && lineSum > 0) {
    const digitDropLikely =
      lineSum === initialTotal * 10 ||
      lineSum === initialTotal * 100 ||
      lineSum >= Math.round(initialTotal * 1.6);
    if (digitDropLikely) {
      return String(bestLineLike ?? lineSum);
    }
  }
  if (initialTotal != null) return String(initialTotal);
  if (bestLineLike != null) return String(bestLineLike);
  if (lineSum > 0) return String(lineSum);
  return "";
}

/** API 等から来る id を number | null に揃え、比較で学習が取りこぼされないようにする */
function normalizeReceiptCategoryId(id: unknown): number | null {
  if (id == null || id === "") return null;
  const n = typeof id === "number" ? id : Number(id);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

const COMBINE_SAME_TIME_PAYMENTS_KEY = "combine_same_time_payments";
const COMBINE_SMALL_SAME_DAY_PAYMENTS_KEY = "combine_small_same_day_payments";

type UnifiedMode = "idle" | "receipt" | "paypay";

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

  const location = useLocation();
  const navigate = useNavigate();

  const [unifiedMode, setUnifiedMode] = useState<UnifiedMode>("idle");
  const [receiptImageObjectUrl, setReceiptImageObjectUrl] = useState<string | null>(null);
  const [paypayText, setPaypayText] = useState("");
  const [paypayErr, setPaypayErr] = useState<string | null>(null);
  const [paypayMsg, setPaypayMsg] = useState<string | null>(null);
  const [paypayLoading, setPaypayLoading] = useState(false);
  const [paypayPreview, setPaypayPreview] = useState<PayPayImportResult | null>(null);
  const [paypayCommitSuccess, setPaypayCommitSuccess] = useState<{
    newCount: number;
    updatedCount: number;
  } | null>(null);
  const paypayCommitRedirectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [combineSameTimePayments, setCombineSameTimePayments] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COMBINE_SAME_TIME_PAYMENTS_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [combineSmallSameDayPayments, setCombineSmallSameDayPayments] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COMBINE_SMALL_SAME_DAY_PAYMENTS_KEY) === "1";
    } catch {
      return false;
    }
  });

  const [notice, setNotice] = useState<string | null>(null);
  /** OCR の店舗名（カテゴリ推定用・画面上は非表示） */
  const [ocrVendor, setOcrVendor] = useState("");
  const [draftMemo, setDraftMemo] = useState("");
  const [draftTotal, setDraftTotal] = useState("");
  const [draftDate, setDraftDate] = useState("");
  const [items, setItems] = useState<
    Array<{
      name: string;
      amount: number | null;
      confidence?: number;
      category?: ReceiptItemCategory;
    }>
  >([]);
  const [receiptMainCategory, setReceiptMainCategory] = useState<ReceiptItemCategory | null>(null);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [draftCategoryId, setDraftCategoryId] = useState<number | null>(null);
  const [categorySuggestSource, setCategorySuggestSource] = useState<
    | "history"
    | "keywords"
    | "global_master"
    | "shared_learning"
    | "chain_catalog"
    | "line_items"
    | "correction"
    | "vendor_key_learn"
    | "ai"
    | null
  >(null);
  const [suggestedCategoryLowConfidence, setSuggestedCategoryLowConfidence] = useState(false);
  const [suggestedCategoryNameHint, setSuggestedCategoryNameHint] = useState<string | null>(null);
  /** 解析結果に付く合計の候補（参考データ・明細合算など） */
  const [totalCandidates, setTotalCandidates] = useState<
    Array<{ total: number; label: string; source: string }>
  >([]);
  const [lastParsePremium, setLastParsePremium] = useState(false);
  const [receiptDictionaryHits, setReceiptDictionaryHits] = useState(0);
  const [suggestedVendorHint, setSuggestedVendorHint] = useState<string | null>(null);
  /** 店名の自動推定の確信度が低い（サーバーが inferenceLowConfidence） */
  const [receiptBedrockVendorLow, setReceiptBedrockVendorLow] = useState(false);
  const [receiptOcrVendorKey, setReceiptOcrVendorKey] = useState<string | null>(null);
  const memoTouchedByUserRef = useRef(false);
  const [receiptAiTaxHint, setReceiptAiTaxHint] = useState<string | null>(null);
  const showTotalCandidateChips = useMemo(
    () =>
      lastParsePremium &&
      (totalCandidates.length >= 2 ||
        totalCandidates.some(
          (c) => c.source === "global" || c.source === "lines" || c.source === "derived",
        )),
    [lastParsePremium, totalCandidates],
  );
  /** 登録時に POST /receipts/learn へ送る直近の取込スナップショット */
  const [lastOcrForLearn, setLastOcrForLearn] = useState<{
    summary: Record<string, unknown>;
    items: Array<{
      name: string;
      amount: number | null;
      confidence?: number;
      category?: string | null;
    }>;
  } | null>(null);
  /** 解析直後のメモ・カテゴリ・金額（学習の誤上書き防止用。遅延する keyword 反映などは ref だけを更新） */
  const loadedReceiptBaselineRef = useRef<{
    memo: string;
    categoryId: number | null;
    totalAmount: number | null;
  } | null>(null);
  /** true のときはカテゴリ変更をユーザー操作とみなし、baseline を自動追従しない */
  const categoryTouchedByUserRef = useRef(false);
  /** 強調色を外す用（再レンダーが必要） */
  const [userEditedCategory, setUserEditedCategory] = useState(false);
  const [receiptFieldConfidence, setReceiptFieldConfidence] = useState<Record<
    string,
    number | null | undefined
  > | null>(null);
  /** 非同期解析ジョブ（他の取込をブロックしない） */
  const [receiptImportQueue, setReceiptImportQueue] = useState<ReceiptImportQueueItem[]>([]);
  const [registering, setRegistering] = useState(false);
  const receiptLineBusy = useMemo(
    () =>
      receiptImportQueue.some((j) => j.status === "pending" || j.status === "processing"),
    [receiptImportQueue],
  );
  /** レシート: Worker 圧縮＋非同期アップロード中（カメラ直後のフリーズ抑止用オーバーレイ） */
  const [receiptIngestPhase, setReceiptIngestPhase] = useState<null | "compress" | "upload">(null);
  /** スマホ: 解析結果を反映した直後に内容確認フォームへスクロールするためのトリガ */
  const [mobileReceiptRevealSeq, setMobileReceiptRevealSeq] = useState(0);
  const isBusy = paypayLoading || Boolean(receiptIngestPhase);
  const displayMainCategory = useMemo(() => {
    const score = new Map<ReceiptItemCategory, number>();
    for (const it of items) {
      const category = (it.category ?? "その他") as ReceiptItemCategory;
      const amt = Number(it.amount ?? NaN);
      score.set(category, (score.get(category) ?? 0) + (Number.isFinite(amt) && amt > 0 ? amt : 0));
    }
    let best: ReceiptItemCategory | null = null;
    let bestScore = 0;
    for (const c of RECEIPT_ITEM_CATEGORIES) {
      const s = score.get(c) ?? 0;
      if (s > bestScore) {
        bestScore = s;
        best = c;
      }
    }
    return best ?? receiptMainCategory;
  }, [items, receiptMainCategory]);
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

  const applyServerParseResult = useCallback(
    (r: ParseReceiptResult) => {
      setTotalCandidates(Array.isArray(r.totalCandidates) ? r.totalCandidates : []);
      {
        const sp = r.suggestedVendor;
        if (sp?.ocrVendorKey) {
          setReceiptOcrVendorKey(sp.ocrVendorKey);
        } else {
          setReceiptOcrVendorKey(null);
        }
        if (sp && sp.suggestedStoreName) {
          setSuggestedVendorHint(
            sp.locationHint
              ? `${sp.suggestedStoreName} / ${sp.locationHint}${sp.fromCache ? "（履歴名寄せ）" : ""}`
              : sp.suggestedStoreName,
          );
        } else {
          setSuggestedVendorHint(null);
        }
        if (sp && !sp.deferred && sp.inferenceLowConfidence === true) {
          setReceiptBedrockVendorLow(true);
        } else if (sp && !sp.deferred) {
          setReceiptBedrockVendorLow(false);
        }
        if (sp?.deferred && sp.rawVendorName) {
          const rawV = String(sp.rawVendorName).trim();
          void (async () => {
            try {
              const res = await resolveReceiptSuggestedVendor({ vendorName: rawV });
              if (res.vendorResolveSkipped && res.userHint) {
                const u = String(res.userHint);
                setNotice((prev) => (prev ? `${u} ${prev}` : u));
              }
              if (!res.found || !res.suggestedVendor) {
                if (res.vendorResolveSkipped) {
                  setReceiptBedrockVendorLow(false);
                }
                return;
              }
              const spr = res.suggestedVendor;
              if (spr.ocrVendorKey) {
                setReceiptOcrVendorKey(spr.ocrVendorKey);
              }
              if (spr.suggestedStoreName) {
                setSuggestedVendorHint(
                  spr.locationHint
                    ? `${spr.suggestedStoreName} / ${spr.locationHint}${spr.fromCache ? "（履歴名寄せ）" : ""}`
                    : spr.suggestedStoreName,
                );
                if (!memoTouchedByUserRef.current) {
                  setDraftMemo(spr.suggestedStoreName);
                }
              }
              if (spr.inferenceLowConfidence === true) {
                setReceiptBedrockVendorLow(true);
              } else {
                setReceiptBedrockVendorLow(false);
              }
            } catch {
              setNotice("解析中ですが、店名推論に接続できませんでした。手入力のまま登録できます。");
            }
          })();
        }
        const rd = r.receiptAiDetail;
        if (rd && rd.taxAmount != null && Number.isFinite(rd.taxAmount)) {
          setReceiptAiTaxHint(
            `参考: 内消費税等 約 ¥${Number(rd.taxAmount).toLocaleString("ja-JP")}（要確認）`,
          );
        } else {
          setReceiptAiTaxHint(null);
        }
      }
      setLastParsePremium(r.subscriptionActive === true);
      setReceiptDictionaryHits(
        typeof r.receiptGlobalDictionaryHitCount === "number" ? r.receiptGlobalDictionaryHitCount : 0,
      );
      setItems(
        (r.items ?? []).map((it) => ({
          ...it,
          category: RECEIPT_ITEM_CATEGORIES.includes((it.category ?? "その他") as ReceiptItemCategory)
            ? ((it.category ?? "その他") as ReceiptItemCategory)
            : "その他",
        })),
      );
      setReceiptMainCategory(
        RECEIPT_ITEM_CATEGORIES.includes((r.mainCategory ?? "") as ReceiptItemCategory)
          ? ((r.mainCategory ?? "") as ReceiptItemCategory)
          : null,
      );
      const s = r.summary;
      if (s && typeof s === "object" && s.fieldConfidence && typeof s.fieldConfidence === "object") {
        setReceiptFieldConfidence(s.fieldConfidence as Record<string, number | null | undefined>);
      } else {
        setReceiptFieldConfidence(null);
      }
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
      const spNow = r.suggestedVendor;
      const initialMemo = pickReceiptMemo({
        suggestedMemo: r.suggestedMemo,
        suggestedStoreName:
          spNow && !spNow.deferred ? String(spNow.suggestedStoreName ?? "").trim() : "",
        vendorName: vendorTrim,
      });
      setDraftMemo(initialMemo);
      setDraftTotal(
        pickInitialTotalAmount(
          s?.totalAmount,
          Array.isArray(r.items) ? r.items : [],
          Array.isArray(r.totalCandidates) ? r.totalCandidates : [],
        ),
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
      const initialCategoryId = normalizeReceiptCategoryId(
        r.suggestedCategoryId ?? spNow?.preferredCategoryId ?? aiNameMatchedId ?? localSuggested,
      );
      setDraftCategoryId(initialCategoryId);
      setSuggestedCategoryLowConfidence(Boolean(r.suggestedCategoryLowConfidence));
      setSuggestedCategoryNameHint(
        r.suggestedCategoryName != null ? String(r.suggestedCategoryName).trim() : null,
      );
      setCategorySuggestSource(
        r.suggestedCategorySource ??
          (r.suggestedCategoryId == null && aiNameMatchedId == null && localSuggested != null
            ? "keywords"
            : null),
      );
      loadedReceiptBaselineRef.current = {
        memo: initialMemo,
        categoryId: initialCategoryId,
        totalAmount:
          s?.totalAmount != null && Number.isFinite(Number(s.totalAmount))
            ? Math.round(Number(s.totalAmount))
            : null,
      };
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
      if (touchUi) {
        setMobileReceiptRevealSeq((n) => n + 1);
      }
    },
    [categories, touchUi],
  );

  useEffect(() => {
    if (mobileReceiptRevealSeq === 0) return;
    if (!touchUi) return;
    const t = window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>("[data-receipt-form]");
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 100);
    return () => clearTimeout(t);
  }, [mobileReceiptRevealSeq, touchUi]);

  useReceiptJob(
    receiptImportQueue,
    setReceiptImportQueue,
    receiptImageObjectUrl,
    applyServerParseResult,
  );

  useEffect(() => {
    if (draftCategoryId != null) return;
    if (!ocrVendor && items.length === 0) return;
    const suggested = suggestExpenseCategoryId(categories, ocrVendor, items);
    if (suggested != null) setDraftCategoryId(normalizeReceiptCategoryId(suggested));
  }, [categories, ocrVendor, items, draftCategoryId]);

  /** 解析時は categories が遅れて届くと keyword 提案が後から入る。baseline.categoryId が null のままだと誤学習するため、ユーザー未操作時だけ追従する */
  useEffect(() => {
    const b = loadedReceiptBaselineRef.current;
    if (!b) return;
    if (categoryTouchedByUserRef.current) return;
    if (b.categoryId != null) return;
    const next = normalizeReceiptCategoryId(draftCategoryId);
    if (next == null) return;
    loadedReceiptBaselineRef.current = { ...b, categoryId: next };
  }, [draftCategoryId]);

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
        "ホーム画面に追加したアプリでは、OS の制限でアルバムの挙動が Safari と異なることがあります。問題があれば Safari で開くか、下の取込から既存の写真を選んでください。",
      );
    }
  }, [isIOS, isStandalone]);

  useEffect(() => {
    return () => {
      if (receiptImageObjectUrl) {
        URL.revokeObjectURL(receiptImageObjectUrl);
      }
    };
  }, [receiptImageObjectUrl]);

  useEffect(
    () => () => {
      if (paypayCommitRedirectTimer.current) {
        clearTimeout(paypayCommitRedirectTimer.current);
        paypayCommitRedirectTimer.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    const s = location.state;
    if (!s || typeof s !== "object") return;
    const prefillImportFile = (s as { prefillImportFile?: File }).prefillImportFile;
    if (prefillImportFile instanceof File) {
      const PREFILL_LAST = "kakeibo-receipt-prefill-last";
      const prefillToken = (s as { prefillReceiptOnce?: string }).prefillReceiptOnce;
      if (typeof prefillToken === "string" && prefillToken.trim()) {
        const t = prefillToken.trim();
        if (t.length > 0 && t.length <= 80) {
          try {
            const prev = globalThis.sessionStorage?.getItem(PREFILL_LAST);
            if (prev === t) {
              navigate(location.pathname, { replace: true, state: null });
              return;
            }
            globalThis.sessionStorage.setItem(PREFILL_LAST, t);
          } catch {
            /* プライベートモード等では二重化防止のみ諦め、URL 上書きで 1 回分は防ぐ */
          }
        }
      }
      void onFile(prefillImportFile);
      navigate(location.pathname, { replace: true, state: null });
      return;
    }
    const raw = (s as { paypayPrefillText?: string }).paypayPrefillText;
    if (typeof raw !== "string" || !raw.trim()) return;
    setPaypayText(raw);
    setUnifiedMode("paypay");
    setPaypayErr(null);
    setPaypayMsg(null);
    setPaypayCommitSuccess(null);
    setPaypayPreview(null);
    setReceiptImageObjectUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.log("[Receipt] prefill PayPay from navigation", { charLength: raw.length });
    }
    void (async () => {
      setPaypayLoading(true);
      try {
        if (!looksLikePayPayCsv(raw)) {
          setPaypayErr("内容が PayPay 取引明細の形式ではありません。");
          return;
        }
        const r = await previewPayPayCsvImport(raw, {
          combineSameTimePayments,
          combineSmallSameDayPayments,
        });
        setPaypayPreview(r);
        setPaypayMsg(
          `プレビュー: 新規 ${r.newCount}件 / 更新 ${r.updatedCount}件 / 合算 ${r.aggregatedCount}件 / 除外 ${r.excludedCount}件`,
        );
      } catch (e) {
        setPaypayErr(e instanceof Error ? e.message : String(e));
      } finally {
        setPaypayLoading(false);
        navigate(location.pathname, { replace: true, state: null });
      }
    })();
  }, [
    location.state,
    location.pathname,
    navigate,
    combineSameTimePayments,
    combineSmallSameDayPayments,
    onFile,
  ]);

  function clearPayPayImport() {
    setPaypayText("");
    setPaypayErr(null);
    setPaypayMsg(null);
    setPaypayPreview(null);
    setPaypayCommitSuccess(null);
  }

  async function runPayPayPreviewForCurrentText() {
    setPaypayErr(null);
    setPaypayMsg(null);
    if (!looksLikePayPayCsv(paypayText)) {
      setPaypayErr("PayPay 取引明細の形式を確認できません。");
      return;
    }
    setPaypayLoading(true);
    try {
      const r = await previewPayPayCsvImport(paypayText, {
        combineSameTimePayments,
        combineSmallSameDayPayments,
      });
      setPaypayPreview(r);
      setPaypayMsg(
        `プレビュー: 新規 ${r.newCount}件 / 更新 ${r.updatedCount}件 / 合算 ${r.aggregatedCount}件 / 除外 ${r.excludedCount}件`,
      );
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.log("[Receipt] PayPay preview OK", { newCount: r.newCount, updatedCount: r.updatedCount });
      }
    } catch (e) {
      setPaypayErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPaypayLoading(false);
    }
  }

  function onChangeCombineFlag(v: boolean) {
    setCombineSameTimePayments(v);
    try {
      localStorage.setItem(COMBINE_SAME_TIME_PAYMENTS_KEY, v ? "1" : "0");
    } catch {
      /* ignore */
    }
  }

  function onChangeSmallMergeFlag(v: boolean) {
    setCombineSmallSameDayPayments(v);
    try {
      localStorage.setItem(COMBINE_SMALL_SAME_DAY_PAYMENTS_KEY, v ? "1" : "0");
    } catch {
      /* ignore */
    }
  }

  async function onPayPayRegisterClick() {
    setPaypayErr(null);
    setPaypayMsg(null);
    if (!looksLikePayPayCsv(paypayText)) {
      setPaypayErr("PayPay 取引明細の形式を確認できません。");
      return;
    }
    setPaypayLoading(true);
    try {
      const r = await commitPayPayCsvImport(paypayText, {
        combineSameTimePayments,
        combineSmallSameDayPayments,
      });
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.log("[Receipt] PayPay commit OK", { newCount: r.newCount, updatedCount: r.updatedCount });
      }
      setPaypayPreview(null);
      setPaypayText("");
      setPaypayMsg(null);
      setPaypayCommitSuccess({ newCount: r.newCount, updatedCount: r.updatedCount });
      if (paypayCommitRedirectTimer.current) {
        clearTimeout(paypayCommitRedirectTimer.current);
      }
      paypayCommitRedirectTimer.current = setTimeout(() => {
        paypayCommitRedirectTimer.current = null;
        setPaypayCommitSuccess(null);
        setUnifiedMode("idle");
        navigate("/");
      }, 2600);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      const isLikelyClientParse = /PayPay|必須列|列が不足|CSV|形式/.test(m);
      setPaypayErr(
        isLikelyClientParse ? `${m} 内容を確認してください。` : "保存に失敗しました。通信環境を確認してください。",
      );
    } finally {
      setPaypayLoading(false);
    }
  }

  async function onFile(f: File | null) {
    if (!f || paypayLoading) return;

    async function loadPayPayFromText(csvText: string, label: string) {
      if (!looksLikePayPayCsv(csvText)) {
        setNotice(
          "この内容は PayPay 取引明細の形式ではありません。拡張子 .csv の明細か、レシート用の画像（JPEG/PNG 等）を選び直してください。",
        );
        return;
      }
      setNotice(null);
      setUnifiedMode("paypay");
      setReceiptImageObjectUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      clearPayPayImport();
      setPaypayText(csvText);
      setPaypayLoading(true);
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.log("[Receipt] PayPay from file", { label, charLength: csvText.length });
      }
      try {
        const r = await previewPayPayCsvImport(csvText, {
          combineSameTimePayments,
          combineSmallSameDayPayments,
        });
        setPaypayPreview(r);
        setPaypayMsg(
          `プレビュー: 新規 ${r.newCount}件 / 更新 ${r.updatedCount}件 / 合算 ${r.aggregatedCount}件 / 除外 ${r.excludedCount}件`,
        );
      } catch (e) {
        setPaypayErr(e instanceof Error ? e.message : String(e));
      } finally {
        setPaypayLoading(false);
      }
    }

    if (isCsvFileName(f.name)) {
      setNotice(null);
      try {
        const csvText = await f.text();
        await loadPayPayFromText(csvText, f.name);
      } catch (e) {
        setNotice(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    if (isTxtFileName(f.name)) {
      setNotice(null);
      try {
        const t = await f.text();
        await loadPayPayFromText(t, f.name);
      } catch (e) {
        setNotice(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    if (!isReceiptImageFile(f)) {
      setNotice(null);
      try {
        const t = await f.text();
        if (looksLikePayPayCsv(t)) {
          await loadPayPayFromText(t, f.name || "明細.txt");
          return;
        }
      } catch (e) {
        setNotice(e instanceof Error ? e.message : String(e));
        return;
      }
      setNotice("画像（JPEG/PNG 等）か、PayPay 取引明細の .csv / .txt を選び直してください。");
      return;
    }
    setNotice(null);
    clearPayPayImport();
    setUnifiedMode("receipt");
    setReceiptIngestPhase("compress");
    let newObjectUrl: string | null = null;
    let compressedBlob: Blob;
    try {
      compressedBlob = await compressReceiptFileToJpegBlob(f);
    } catch (e) {
      setReceiptIngestPhase(null);
      setNotice(e instanceof Error ? e.message : String(e));
      return;
    }
    newObjectUrl = URL.createObjectURL(compressedBlob);
    setReceiptImageObjectUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return newObjectUrl;
    });
    setOcrVendor("");
    setDraftMemo("");
    setDraftTotal("");
    setDraftDate("");
    setDraftCategoryId(null);
    setCategorySuggestSource(null);
    setSuggestedCategoryLowConfidence(false);
    setSuggestedCategoryNameHint(null);
    setTotalCandidates([]);
    setSuggestedVendorHint(null);
    setReceiptAiTaxHint(null);
    setLastParsePremium(false);
    setReceiptDictionaryHits(0);
    setItems([]);
    setReceiptMainCategory(null);
    setLastOcrForLearn(null);
    loadedReceiptBaselineRef.current = null;
    setReceiptOcrVendorKey(null);
    setReceiptBedrockVendorLow(false);
    memoTouchedByUserRef.current = false;
    categoryTouchedByUserRef.current = false;
    setUserEditedCategory(false);
    setReceiptFieldConfidence(null);
    try {
      setReceiptIngestPhase("upload");
      const jpgName = (() => {
        const base = f.name || "receipt";
        if (/\.(jpe?g|png|gif|webp|heic|heif|bmp|tiff?)$/i.test(base)) {
          return base.replace(/\.[^.]+$/, ".jpg");
        }
        return `${base}.jpg`;
      })();
      const u = await uploadReceiptForAsyncJob(compressedBlob, {
        debugForceReceiptTier: receiptDebugTier,
        fileName: jpgName,
        onProgress: (p) => {
          void p;
        },
      });
      setReceiptImportQueue((prev) => {
        if (prev.some((q) => q.jobId === u.jobId)) return prev;
        return [
          ...prev,
          {
            localKey: crypto.randomUUID(),
            fileName: f.name,
            objectUrl: newObjectUrl!,
            jobId: u.jobId,
            status: (u.status as ReceiptAsyncJobStatus) || "pending",
            progressPct: 0,
          },
        ];
      });
      setNotice("アップロード完了。解析結果は順次この画面に反映されます。");
    } catch (e) {
      if (newObjectUrl) {
        URL.revokeObjectURL(newObjectUrl);
        setReceiptImageObjectUrl((prev) => (prev === newObjectUrl ? null : prev));
      }
      setNotice(e instanceof Error ? e.message : String(e));
      setItems([]);
      setReceiptMainCategory(null);
      setSuggestedVendorHint(null);
      setReceiptOcrVendorKey(null);
      setReceiptAiTaxHint(null);
      setLastParsePremium(false);
      setReceiptDictionaryHits(0);
      setReceiptFieldConfidence(null);
    } finally {
      setReceiptIngestPhase(null);
    }
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    void onFile(e.target.files?.[0] ?? null);
    e.target.value = "";
  }

  const pickDisabled = isBusy ? styles.receiptPickBtnDisabled : "";

  const dateField = useMemo(() => dateFieldMode(draftDate), [draftDate]);

  const receiptLineSumCheck = useMemo(() => {
    const lineSum = items.reduce((acc, it) => {
      const n = Number(it.amount);
      if (!Number.isFinite(n) || n <= 0) return acc;
      return acc + n;
    }, 0);
    const raw = draftTotal.replace(/[, 　]/g, "");
    const total = Number.parseFloat(raw);
    if (items.length === 0) return { mismatch: false, lineSum, total };
    if (!Number.isFinite(total) || total <= 0) return { mismatch: false, lineSum, total };
    if (lineSum <= 0) return { mismatch: false, lineSum, total };
    return { mismatch: Math.abs(lineSum - total) > 2, lineSum, total };
  }, [items, draftTotal]);

  const fc = receiptFieldConfidence;
  const lowOcrFieldConf = (k: "date" | "totalAmount" | "vendorName") => {
    const n = fc?.[k];
    return typeof n === "number" && n < 0.9;
  };
  const categoryFieldLowConfidence = suggestedCategoryLowConfidence && !userEditedCategory;
  const amountFieldLowConfidence =
    receiptLineSumCheck.mismatch || lowOcrFieldConf("totalAmount");
  const dateFieldLowConfidence = lowOcrFieldConf("date");
  const memoFieldLowConfidence = lowOcrFieldConf("vendorName") || receiptBedrockVendorLow;
  const fieldTooltip = (low: boolean) => (low ? RECEIPT_AI_INFERENCE_HINT : undefined);

  const busyLabel =
    receiptIngestPhase === "compress"
      ? "画像圧縮中…"
      : receiptIngestPhase === "upload"
        ? "送信中…"
        : "明細を処理中…";
  const loadingUi = (
    <>
      {touchUi ? (
        <div className={styles.receiptLoadingPanel} role="status" aria-live="polite" aria-busy="true">
          <span className={styles.receiptSpinner} aria-hidden />
          <span>{busyLabel}</span>
        </div>
      ) : (
        <div
          className={styles.receiptLoadingPanel}
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          <span className={styles.receiptSpinner} aria-hidden />
          <span>{busyLabel}</span>
        </div>
      )}
    </>
  );

  return (
    <div className={`${styles.wrap} ${styles.receiptImportWrap}`}>
      {Boolean(receiptIngestPhase) ? loadingUi : null}
      <h1 className={styles.title}>レシート・明細取込</h1>
      {receiptImportQueue.length > 0 ? (
        <ul
          className={styles.receiptImportQueueList}
          aria-label="取込中のレシート（解析状況）"
        >
          {receiptImportQueue.map((row) => {
            const busy = row.status === "pending" || row.status === "processing";
            return (
              <li key={row.localKey} className={styles.receiptImportQueueItem}>
                <img
                  className={styles.receiptImportQueueThumb}
                  src={row.objectUrl}
                  alt=""
                />
                <div className={styles.receiptImportQueueBody}>
                  <span className={styles.receiptImportQueueFileName}>{row.fileName}</span>
                  {busy && row.status === "pending" ? (
                    <div
                      className={styles.receiptImportQueueRowBusy}
                      role="status"
                      aria-live="polite"
                    >
                      <span className={styles.receiptImportQueueSkeletonBar} />
                      <span>画像最適化・送信中…</span>
                    </div>
                  ) : busy && row.status === "processing" ? (
                    <div
                      className={styles.receiptImportQueueRowBusy}
                      role="status"
                      aria-live="polite"
                    >
                      <span className={styles.receiptImportQueueSkeletonBar} />
                      <span>解析中…</span>
                    </div>
                  ) : row.status === "failed" ? (
                    <div className={styles.receiptImportQueueError} style={{ display: "grid", gap: "0.45rem" }}>
                      <span>
                        {formatReceiptQueueFailureMessage(row.errorMessage, row.result)}
                      </span>
                      <button
                        type="button"
                        className={`${styles.btn} ${styles.btnSm}`}
                        onClick={() => {
                          setUnifiedMode("receipt");
                          setNotice("解析に失敗したため、手動入力に切り替えました。");
                        }}
                      >
                        スキップして手動入力
                      </button>
                      <button
                        type="button"
                        className={`${styles.btn} ${styles.btnSm}`}
                        disabled={isBusy}
                        onClick={() => {
                          setNotice(null);
                          galleryInputRef.current?.click();
                        }}
                      >
                        写真を選び直す
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: "grid", gap: "0.4rem" }}>
                      <span className={styles.receiptImportQueueOk}>
                        {touchUi
                          ? "解析が完了しました。内容を確認・修正してから登録してください。"
                          : "解析が完了しました（下のプレビューに反映）"}
                      </span>
                      {touchUi ? (
                        <button
                          type="button"
                          className={`${styles.btn} ${styles.btnSm}`}
                          onClick={() => {
                            document
                              .querySelector<HTMLElement>("[data-receipt-form]")
                              ?.scrollIntoView({ behavior: "smooth", block: "start" });
                          }}
                        >
                          内容確認へ
                        </button>
                      ) : null}
                    </div>
                  )}
                  {busy && row.timeoutExceeded ? (
                    <div className={styles.modeRow} style={{ gap: "0.4rem", flexWrap: "wrap" }}>
                      <button
                        type="button"
                        className={`${styles.btn} ${styles.btnSm}`}
                        onClick={() => {
                          setUnifiedMode("receipt");
                          setNotice("解析待ちが長いため、手動入力に切り替えました。");
                        }}
                      >
                        スキップして手動入力
                      </button>
                      <button
                        type="button"
                        className={`${styles.btn} ${styles.btnSm}`}
                        onClick={() => {
                          setNotice("自動再試行中です。しばらくしても完了しない場合は手動入力をご利用ください。");
                        }}
                      >
                        自動再試行中
                      </button>
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {import.meta.env.DEV && receiptDebugTier !== "server" ? (
        <p
          className={styles.infoText}
          style={{ marginTop: "0.35rem", maxWidth: 640 }}
        >
          開発用: レシート取込の挙動を「{receiptDebugTier === "free" ? "制限あり" : "拡張あり"}
          」に固定しています。設定画面のボタンで切り替えられます。
        </p>
      ) : null}

      {/* file input は flex 行の外に置き、一部モバイル WebView でレイアウトに影響しないようにする */}
      {touchUi ? (
        <input
          key="receipt-gallery-mobile"
          ref={galleryInputRef}
          id={galleryInputId}
          type="file"
          accept={UNIFIED_IMPORT_ACCEPT}
          multiple={false}
          className="visually-hidden"
          disabled={isBusy}
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
          accept={UNIFIED_IMPORT_ACCEPT}
          className="visually-hidden"
          disabled={isBusy}
          onChange={handleFileChange}
          tabIndex={-1}
          aria-hidden
        />
      )}
      <FeatureGate feature={FEATURE_RECEIPT_AI} mode="lock">
        <div className={styles.receiptPickRow}>
          <button
            type="button"
            className={`${styles.receiptPickBtn} ${styles.receiptPickBtnPrimary} ${pickDisabled}`}
            onClick={() => {
              setNotice(null);
              galleryInputRef.current?.click();
            }}
            disabled={isBusy}
          >
            写真・データ取込
          </button>
        </div>
      </FeatureGate>

      {unifiedMode === "paypay" && paypayCommitSuccess ? (
        <div
          role="status"
          aria-live="polite"
          className={styles.settingsPanel}
          style={{
            marginBottom: "0.75rem",
            padding: "0.75rem 0.9rem",
            border: "1px solid var(--accent, #2d9f6c)",
            background: "color-mix(in srgb, var(--accent, #2d9f6c) 14%, transparent)",
          }}
        >
          <p style={{ margin: 0, fontWeight: 600 }}>
            取り込みが完了しました（新規 {paypayCommitSuccess.newCount} 件 / 更新 {paypayCommitSuccess.updatedCount}{" "}
            件）
          </p>
          <p className={styles.reclassifyHint} style={{ margin: "0.35rem 0 0" }}>
            まもなく家計簿の画面へ移動します…
          </p>
        </div>
      ) : null}

      {unifiedMode === "paypay" && !paypayCommitSuccess ? (
        <div
          className={styles.settingsPanel}
          style={{ marginBottom: "0.75rem", padding: "0.75rem 0.85rem" }}
        >
          <div
            role="status"
            style={{
              marginBottom: "0.75rem",
              padding: "0.65rem 0.8rem",
              borderRadius: 8,
              border: "1px solid color-mix(in srgb, var(--accent, #2d9f6c) 45%, transparent)",
              background: "color-mix(in srgb, var(--accent, #2d9f6c) 12%, transparent)",
              lineHeight: 1.55,
            }}
          >
            <p style={{ margin: 0, fontWeight: 600, fontSize: "0.95rem" }}>
              PayPay のログイン情報は求めていません
            </p>
            <p className={styles.reclassifyHint} style={{ margin: "0.4rem 0 0" }}>
              PayPay 公式アプリ等から取引明細の CSV を書き出し、下欄に貼り付けるかファイルとして選んでアップロードしてください。
            </p>
          </div>
          <p className={styles.sub} style={{ margin: "0 0 0.5rem" }}>
            PayPay 明細: 拡張子 <code>.csv</code> を優先、内容の1行目で判別（<code>file.type</code> には依存しません）。
          </p>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, marginBottom: "0.5rem" }}>
            <input
              type="checkbox"
              checked={combineSameTimePayments}
              onChange={(e) => onChangeCombineFlag(e.target.checked)}
              disabled={paypayLoading}
            />
            同一店舗・10分以内の支払いを合算
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, marginBottom: "0.5rem", marginLeft: "0.85rem" }}>
            <input
              type="checkbox"
              checked={combineSmallSameDayPayments}
              onChange={(e) => onChangeSmallMergeFlag(e.target.checked)}
              disabled={paypayLoading}
            />
            500円未満は同日・同店舗で合算（時間を無視）
          </label>
          {paypayPreview ? (
            <p className={styles.reclassifyHint} style={{ margin: "0 0 0.45rem" }}>
              対象行: {paypayPreview.totalRows} / 新規: {paypayPreview.newCount} / 更新: {paypayPreview.updatedCount} / 合算:{" "}
              {paypayPreview.aggregatedCount} / 除外: {paypayPreview.excludedCount} / エラー: {paypayPreview.errorCount}
            </p>
          ) : null}
          <textarea
            value={paypayText}
            onChange={(e) => {
              setPaypayText(e.target.value);
              setPaypayPreview(null);
            }}
            rows={8}
            placeholder="PayPay 取引CSV（必要なら編集可）"
            style={{
              width: "100%",
              boxSizing: "border-box",
              fontFamily: "monospace",
              fontSize: "0.82rem",
              padding: "0.6rem",
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "rgba(0,0,0,0.25)",
              color: "var(--text)",
              marginBottom: "0.5rem",
            }}
          />
          {paypayErr ? (
            <p className={styles.err} role="alert" style={{ marginBottom: "0.4rem" }}>
              {paypayErr}
            </p>
          ) : null}
          {paypayMsg && !paypayErr ? (
            <p style={{ color: "var(--accent)", margin: "0 0 0.4rem" }}>{paypayMsg}</p>
          ) : null}
          <div className={styles.modeRow} style={{ flexWrap: "wrap", gap: "0.45rem" }}>
            <button
              type="button"
              className={styles.btn}
              disabled={paypayLoading || !paypayText.trim()}
              onClick={() => {
                void runPayPayPreviewForCurrentText();
              }}
            >
              プレビュー更新
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              disabled={paypayLoading || !paypayText.trim() || !looksLikePayPayCsv(paypayText)}
              onClick={() => {
                void onPayPayRegisterClick();
              }}
            >
              登録
            </button>
          </div>
        </div>
      ) : null}

      {unifiedMode === "idle" && !receiptImageObjectUrl ? (
        <p className={styles.sub} style={{ margin: "0.2rem 0 0.85rem" }}>
          銀行の明細用CSVは
          <Link to="/import" style={{ color: "var(--accent)" }}>
            銀行・カード明細取込
          </Link>
          へ。
        </p>
      ) : null}

      {unifiedMode === "receipt" ? (
        <div
          className={receiptImageObjectUrl ? styles.receiptReviewLayout : undefined}
          style={!receiptImageObjectUrl ? ({ display: "contents" } as const) : undefined}
        >
          {receiptImageObjectUrl ? (
            <aside className={styles.receiptReviewImageCol} aria-label="元のレシート画像">
              <ReceiptRegionRescanPanel
                imageObjectUrl={receiptImageObjectUrl}
                busy={receiptLineBusy}
                onCroppedFile={(f) => {
                  void onFile(f);
                }}
                resultPreview={{ date: draftDate, total: draftTotal, memo: draftMemo }}
                ingestStatusMessage={
                  receiptIngestPhase === "compress"
                    ? "画像を準備中…"
                    : receiptIngestPhase === "upload"
                      ? "アップロード中…"
                      : null
                }
                parsingOcr={receiptLineBusy}
              />
            </aside>
          ) : null}
          <div
            className={receiptImageObjectUrl ? styles.receiptReviewFormCol : undefined}
            style={!receiptImageObjectUrl ? ({ display: "contents" } as const) : undefined}
          >
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
              ? "過去の取引から自動反映しました（必要なら変更できます）。"
              : categorySuggestSource === "correction"
                ? "過去の修正内容を反映しました（必要なら変更できます）。"
                : categorySuggestSource === "vendor_key_learn"
                  ? "同じ店名に対して以前選んだカテゴリを優先しました（必要なら変更できます）。"
                : categorySuggestSource === "global_master"
                  ? "参考データからカテゴリを推測しました（必要なら変更できます）。"
                : categorySuggestSource === "shared_learning"
                  ? "共有学習データからカテゴリを提案しました（必要なら変更できます）。"
                : categorySuggestSource === "ai"
                  ? "カテゴリを自動で提案しました（必要なら変更できます）。"
                : "カテゴリ候補を自動提案しました（必要なら変更できます）。"}
          </p>
        ) : null}
        {suggestedCategoryLowConfidence && !draftCategoryId && suggestedCategoryNameHint ? (
          <p className={styles.receiptSummaryHint} style={{ marginTop: "-0.2rem" }}>
            未分類（推測: {suggestedCategoryNameHint}）
          </p>
        ) : null}
        {receiptLineSumCheck.mismatch && items.length > 0 ? (
          <p className={styles.receiptTotalMismatch} role="status">
            明細行の合計（¥{receiptLineSumCheck.lineSum.toLocaleString("ja-JP")}）が
            入力中の合計
            {Number.isFinite(receiptLineSumCheck.total) ? `（¥${receiptLineSumCheck.total.toLocaleString("ja-JP")}）` : ""}
            と揃いません。税抜/税別・消費税行・割引行・ポイント利用のときは、合計欄に店頭の
            お支払い金額（税込合計）を合わせてください。
          </p>
        ) : null}
        {suggestedVendorHint ? (
          <p
            className={styles.receiptSummaryHint}
            style={{ gridColumn: "1 / -1" }}
            title="読み取った表記を店名として整えた結果です。メモ欄のツールチップでも確認できます。"
          >
            推定店名: {suggestedVendorHint}
          </p>
        ) : null}
        <div className={`${styles.field} ${styles.receiptFieldKind}`}>
          <label htmlFor={kindFieldId}>種別</label>
          <select id={kindFieldId} value="expense" disabled aria-readonly>
            <option value="expense">支出</option>
          </select>
        </div>
        <div
          className={`${styles.field} ${styles.receiptFieldCategory} ${
            categoryFieldLowConfidence ? styles.receiptFieldLowConfidence : ""
          }`}
        >
          <label htmlFor={categoryFieldId}>カテゴリ</label>
          <select
            id={categoryFieldId}
            value={draftCategoryId ?? ""}
            title={fieldTooltip(categoryFieldLowConfidence)}
            onChange={(e) => {
              categoryTouchedByUserRef.current = true;
              setUserEditedCategory(true);
              setDraftCategoryId(
                e.target.value ? normalizeReceiptCategoryId(Number(e.target.value)) : null,
              );
            }}
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
        <div
          className={`${styles.field} ${styles.receiptFieldDate} ${
            dateFieldLowConfidence ? styles.receiptFieldLowConfidence : ""
          }`}
        >
          <label htmlFor={dateFieldId}>日付</label>
          {dateField.kind === "iso" ? (
            <input
              id={dateFieldId}
              type="date"
              value={dateField.value}
              title={fieldTooltip(dateFieldLowConfidence)}
              onChange={(e) => setDraftDate(e.target.value)}
            />
          ) : (
            <input
              id={dateFieldId}
              type="text"
              inputMode="numeric"
              placeholder="YYYY-MM-DD など"
              value={dateField.value}
              title={fieldTooltip(dateFieldLowConfidence)}
              onChange={(e) => setDraftDate(e.target.value)}
            />
          )}
        </div>
        <div
          className={`${styles.field} ${styles.receiptFieldAmount} ${
            amountFieldLowConfidence ? styles.receiptFieldLowConfidence : ""
          }`}
        >
          <label htmlFor={totalFieldId}>金額</label>
          <input
            id={totalFieldId}
            type="text"
            inputMode="decimal"
            placeholder="1200"
            value={draftTotal}
            title={fieldTooltip(amountFieldLowConfidence)}
            onChange={(e) => setDraftTotal(e.target.value)}
          />
          {receiptAiTaxHint ? (
            <p className={styles.receiptCategoryHint} style={{ marginTop: "0.35rem" }}>
              {receiptAiTaxHint}
            </p>
          ) : null}
        </div>
        {showTotalCandidateChips ? (
          <div className={`${styles.field} ${styles.receiptFieldTotalCandidates}`}>
            <span className={styles.sub} style={{ display: "block", marginBottom: "0.35rem" }}>
              合計の候補
              {receiptDictionaryHits > 0 ? (
                <span style={{ marginLeft: "0.35rem", opacity: 0.85 }}>
                  · 参考 {receiptDictionaryHits} 件
                </span>
              ) : null}
            </span>
            <div className={`${styles.modeRow} ${styles.receiptTotalCandidateRow}`}>
              {totalCandidates.map((c, idx) => (
                <button
                  key={`${c.source}-${c.total}-${idx}`}
                  type="button"
                  className={styles.btn}
                  onClick={() => setDraftTotal(String(c.total))}
                  title={c.label}
                >
                  ¥{c.total.toLocaleString("ja-JP")}
                  <span className={styles.sub} style={{ marginLeft: "0.25rem", fontSize: "0.82em" }}>
                    {c.source === "global"
                      ? "参考"
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
          className={`${styles.field} ${styles.receiptMemoField} ${styles.receiptFieldMemo} ${
            memoFieldLowConfidence ? styles.receiptFieldLowConfidence : ""
          }`}
        >
          <label htmlFor={memoFieldId}>メモ</label>
          <input
            id={memoFieldId}
            type="text"
            autoComplete="off"
            placeholder="内容"
            value={draftMemo}
            title={
              suggestedVendorHint
                ? `名寄せ済み: 推定店名をメモに入れています。編集すると上書きされます。${
                    memoFieldLowConfidence ? ` ${RECEIPT_AI_INFERENCE_HINT}` : ""
                  }`
                : memoFieldLowConfidence
                  ? RECEIPT_AI_INFERENCE_HINT
                  : undefined
            }
            onChange={(e) => {
              memoTouchedByUserRef.current = true;
              setDraftMemo(e.target.value);
            }}
          />
        </div>
        {items.length > 0 ? (
          <div className={`${styles.field} ${styles.receiptMemoField} ${styles.receiptFieldLineItems}`}>
            <label style={{ marginBottom: "0.35rem" }}>明細カテゴリ（自動判定・手動修正可）</label>
            {displayMainCategory ? (
              <p className={styles.receiptSummaryHint} style={{ marginBottom: "0.5rem" }}>
                レシート全体メインカテゴリ: {displayMainCategory}
              </p>
            ) : null}
            <div style={{ display: "grid", gap: "0.45rem" }}>
              {items.map((it, idx) => {
                const lineAmt = Number(it.amount);
                const hasAmt = Number.isFinite(lineAmt) && lineAmt > 0;
                return (
                <div
                  key={`${it.name}-${idx}`}
                  className={
                    typeof it.confidence === "number" && it.confidence < 0.9
                      ? styles.receiptItemRowLowConfidence
                      : undefined
                  }
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0,1fr) minmax(7rem,auto) auto",
                    gap: "0.45rem",
                    alignItems: "center",
                  }}
                >
                  <span className={styles.sub}>
                    {it.name}
                    {hasAmt ? `（¥${lineAmt.toLocaleString("ja-JP")}）` : ""}
                  </span>
                  <select
                    value={it.category ?? "その他"}
                    onChange={(e) => {
                      const next = e.target.value as ReceiptItemCategory;
                      setItems((prev) =>
                        prev.map((row, i) => (i === idx ? { ...row, category: next } : row)),
                      );
                    }}
                    aria-label={`行${idx + 1}の品目分類`}
                  >
                    {RECEIPT_ITEM_CATEGORIES.map((cat) => (
                      <option key={cat} value={cat}>
                        {cat}
                      </option>
                    ))}
                  </select>
                  {hasAmt ? (
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnSm}`}
                      onClick={() => {
                        setDraftTotal(String(Math.round(lineAmt)));
                        setNotice(null);
                      }}
                      title="この行の金額を、上段の合計欄（登録用の金額）に反映します"
                    >
                      合計に
                    </button>
                  ) : (
                    <span aria-hidden="true" />
                  )}
                </div>
                );
              })}
            </div>
          </div>
        ) : null}

        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary} ${styles.receiptFormSubmit}`}
          disabled={
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
              const submittedCat = normalizeReceiptCategoryId(draftCategoryId);
              await createTransaction({
                kind: "expense",
                amount,
                transaction_date: dateField.value,
                memo: draftMemo.trim() || null,
                category_id: submittedCat,
                from_receipt: true,
              });
              if (lastOcrForLearn?.summary) {
                const itemsForLearn = items.map((row) => ({
                  name: row.name,
                  amount: row.amount ?? null,
                  category: row.category ?? null,
                  confidence: row.confidence,
                }));
                void saveReceiptOcrCorrection({
                  summary: lastOcrForLearn.summary,
                  items: itemsForLearn,
                  category_id: submittedCat,
                  memo: draftMemo.trim() || null,
                  confirmed_total_amount: amount,
                  confirmed_date: dateField.value,
                }).catch(() => {});
              }
              if (receiptOcrVendorKey && lastParsePremium) {
                void savePlaceCategoryPreference({
                  ocrVendorKey: receiptOcrVendorKey,
                  categoryId: submittedCat,
                  vendorName: (draftMemo.trim() || ocrVendor || "").trim() || undefined,
                }).catch(() => {});
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
          </div>
        </div>
      ) : null}

      {notice ? (
        <p className={styles.infoText} style={{ marginBottom: "1rem" }}>
          {notice}
        </p>
      ) : null}

      {!touchUi && unifiedMode === "receipt" && items.length === 0 ? (
        <p className={styles.sub}>画像を選択すると、合計金額を自動で反映します。</p>
      ) : null}
    </div>
  );
}
