/**
 * Lambda / Express 共通ルータ
 */
import crypto from "node:crypto";
import { stripApiPathPrefix } from "./api-path.mjs";
import {
  tryAuthRoutes,
  getDefaultFamilyId,
  resolveFamilyIdWithChatFallback,
} from "./auth-routes.mjs";
import { canAccessFamilyChat } from "./family-chat-access.mjs";
import { sqlUserFamilyIdExpr } from "./family-billing-scope.mjs";
import { hashPassword, resolveUserId, validatePassword } from "./auth-logic.mjs";
import { buildCorsHeaders } from "./cors-config.mjs";
import { getPool, isRdsConfigured, pingDatabase } from "./db.mjs";
import { createLogger } from "./logger.mjs";
import {
  analyzeReceiptImageBytes,
  decodeImageBuffer,
} from "./textract-receipt.mjs";
import { seedDefaultCategoriesIfEmpty } from "./category-defaults.mjs";
import {
  buildReceiptOcrSnapshot,
  receiptOcrMatchKey,
} from "./receipt-learn.mjs";
import {
  buildReceiptTotalCandidates,
  fetchGlobalReceiptTotalsBySummaryWindow,
  mergeSummaryForGlobalFingerprint,
  upsertGlobalReceiptOcrStat,
} from "./global-receipt-ocr.mjs";
import {
  mergeDuplicateCategories,
  normalizeCategoryNameKey,
} from "./category-utils.mjs";
import {
  askBedrockAdvisor,
  askBedrockHybridReceiptFromTextract,
  askBedrockReceiptAssistant,
  inferReceiptImageMediaTypeFromBuffer,
} from "./ai-advisor-service.mjs";
import { ocrVendorFingerprintHex } from "./vendor-fingerprint.mjs";
import {
  getUserStorePlaceCached,
  resolveAndPersistUserStorePlace,
  upsertPreferredCategoryForOcrKey,
} from "./user-store-places.mjs";
import {
  deriveSubscriptionStatusFromDbRow,
  getEffectiveSubscriptionStatus,
  isUserIdForcedPremiumByEnv,
  normalizeAdminSettableSubscriptionStatus,
  bodyContainsSubscriptionMutationFields,
  userHasPremiumSubscriptionAccess,
} from "./subscription-logic.mjs";
import { cancelUserSubscriptionAtPeriodEnd } from "./stripe-billing-cancel.mjs";
import { fetchSubscriptionPeriodEndIsoFromStripeLive } from "./stripe-billing-subscription-period.mjs";
import { createBillingPortalSession } from "./stripe-billing-portal.mjs";
import {
  createBillingCheckoutSession,
  getStripeCheckoutPublicConfig,
} from "./stripe-checkout.mjs";
import { processStripeWebhook } from "./stripe-webhook.mjs";
import {
  executePayPayCsvImport,
  writePayPayMonitorLog,
} from "./paypay-import.mjs";
import {
  AccountDeletionDbError,
  performUserAccountDeletion,
} from "./account-delete.mjs";
import Stripe from "stripe";
import { requireStripeSecretKey } from "./stripe-config.mjs";
import {
  applyOneFamilyMismatch,
  applyOneUserMismatch,
  compareStripeSubscriptionsWithDb,
} from "./stripe-subscription-reconcile-core.mjs";
import { applyEstimatedFeeToLogRowForDisplay } from "./stripe-sales-fee-estimate.mjs";
import { getPublicUserStatsPayload } from "./user-stats-public.mjs";
import {
  evaluateAllFeaturesForUser,
  evaluateFeatureForUser,
  fetchAllFeaturePermissions,
  normalizeFeatureKey,
  normalizeMinPlan,
  setFeaturePermissionMinPlan,
} from "./feature-permissions.mjs";

const logger = createLogger("api");

function logError(event, e, extra = {}) {
  logger.error(event, e, extra);
}

/** 一般ユーザー向け API では DB の subscription を書き換えられない（管理者 PATCH のみ可） */
function rejectNonAdminSubscriptionBodyFields(b, hdrs, skipCors) {
  if (!bodyContainsSubscriptionMutationFields(b)) return null;
  return json(
    400,
    {
      error: "InvalidRequest",
      detail: "サブスクリプション状態は管理者のみが変更できます",
    },
    hdrs,
    skipCors,
  );
}

/** クライアントの debugForceReceiptTier を受け付けるか（本番は既定オフ） */
function isReceiptSubscriptionDebugAllowed() {
  const flag = String(process.env.RECEIPT_DEBUG_SUBSCRIPTION_TIER ?? "").trim();
  if (flag === "1" || flag.toLowerCase() === "true") return true;
  return String(process.env.NODE_ENV).toLowerCase() !== "production";
}

function json(statusCode, body, reqHeaders, skipCors) {
  const cors = skipCors ? {} : buildCorsHeaders(reqHeaders);
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...cors,
    },
    body: JSON.stringify(body),
  };
}

function routeKey(method, path) {
  const p = path.replace(/\/$/, "") || "/";
  return `${method} ${p}`;
}

function formatDateYmd(value) {
  if (value == null || value === "") return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function toCsvCell(value) {
  const s = value == null ? "" : String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function formatRoundedInteger(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "0";
  return String(Math.round(n));
}

function buildSalesDailyCsv(rows) {
  const header = ["日付", "取引種別", "総額", "手数料", "純利益", "ユーザー名", "Stripe決済ID"];
  const lines = [header.map((x) => toCsvCell(x)).join(",")];
  for (const row of rows) {
    lines.push(
      [
        formatDateYmd(row.day_key),
        String(row.source_kind ?? ""),
        formatRoundedInteger(row.gross_total),
        formatRoundedInteger(row.fee_total),
        formatRoundedInteger(row.net_total),
        String(row.user_name ?? ""),
        String(row.stripe_payment_id ?? ""),
      ]
        .map((x) => toCsvCell(x))
        .join(","),
    );
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

/** 収入は 0 円可。支出は正の数のみ。 */
function validateTransactionAmount(kind, amt) {
  if (!Number.isFinite(amt) || amt < 0) {
    return { ok: false, error: "金額が不正です" };
  }
  if (kind === "income") {
    return { ok: true };
  }
  if (amt <= 0) {
    return {
      ok: false,
      error: "支出の金額は正の数である必要があります",
    };
  }
  return { ok: true };
}

/** 旧運用の「固定費」支出カテゴリ。設定の固定費に移行済みのため取引では禁止し、集計から除外する。 */
const RESERVED_LEDGER_FIXED_COST_CATEGORY = "固定費";

function normalizeLedgerCategoryNameForCompare(name) {
  return String(name ?? "")
    .normalize("NFKC")
    .replace(/[\u200b-\u200f\ufeff\u2060]/g, "")
    .trim();
}

function isReservedLedgerFixedCostCategoryName(name) {
  return normalizeLedgerCategoryNameForCompare(name) === RESERVED_LEDGER_FIXED_COST_CATEGORY;
}

/**
 * 支出で「固定費」カテゴリを使わせない（設定画面の固定費のみで管理）。
 * @returns {Promise<string|null>} エラーメッセージ or null
 */
async function rejectExpenseUsingLedgerFixedCategory(pool, catWhere, userPair, kind, categoryId) {
  if (kind !== "expense" || categoryId == null || !Number.isFinite(Number(categoryId))) {
    return null;
  }
  const [[row]] = await pool.query(
    `SELECT TRIM(IFNULL(c.name, '')) AS n FROM categories c
     WHERE c.id = ? AND (${catWhere}) LIMIT 1`,
    [Number(categoryId), ...userPair],
  );
  if (!row) return "カテゴリが見つかりません";
  if (isReservedLedgerFixedCostCategoryName(row.n)) {
    return "「固定費」カテゴリの支出は登録できません。設定画面の固定費を利用してください。";
  }
  return null;
}

function buildAdvisorFallbackReply(message, ctx) {
  const income = Number(ctx?.incomeTotal ?? 0);
  const expense = Number(ctx?.expenseTotal ?? 0);
  const fixed = Number(ctx?.fixedCostFromSettings ?? 0);
  const fixedInNet = income > 0 || expense > 0 ? fixed : 0;
  const netRaw =
    ctx?.netMonthlyBalance != null && Number.isFinite(Number(ctx.netMonthlyBalance))
      ? Number(ctx.netMonthlyBalance)
      : income - expense - fixedInNet;
  const rest = Math.max(0, Math.round(netRaw));
  const top = Array.isArray(ctx?.topCategories) ? ctx.topCategories[0] : null;
  const topName = top?.name ? String(top.name) : "変動費";
  const topTotal = Number(top?.total ?? 0);
  const msg = String(message ?? "");
  const lower = msg.toLowerCase();

  if (msg.includes("あといくら") || msg.includes("残り")) {
    return `今月の残り予算は${rest.toLocaleString("ja-JP")}円です。${topName}の上限を先に決めると、使い過ぎを防ぎやすくなります。`;
  }
  if (msg.includes("解析") || msg.includes("読み取り") || msg.includes("読取")) {
    return "レシート画面で「レシート取込」を押して画像を選ぶと、合計・日付・カテゴリ候補が自動入力されます。内容確認後に「登録」を押せば家計簿へ保存できます。";
  }
  if (msg.includes("登録方法") || msg.includes("登録") || lower.includes("how to register")) {
    return "家計簿の「取引を追加」で種別・カテゴリ・日付・金額を入力し「追加」を押すと登録できます。レシート取込なら読み取り後に内容確認して「登録」を押してください。";
  }
  if (msg.includes("使い方")) {
    return `「固定費を減らしたい」「${topName}を抑えたい」のように、カテゴリ名つきで質問すると具体案を返しやすいです。今月は${topName}が${topTotal.toLocaleString("ja-JP")}円なので、まずはここから見直しましょう。`;
  }
  if (msg.includes("食費")) {
    return `食費は「週予算」を先に決めるのが効果的です。今週分を封筒方式で分けると、月末のオーバーを防ぎやすくなります。`;
  }
  return `まずは固定費（通信費・保険・サブスク）を見直し、次に${topName}の上限を先に決めるのがおすすめです。今月の残り予算は${rest.toLocaleString("ja-JP")}円です。`;
}

function normalizeTxMemo(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim().slice(0, 500);
  return s === "" ? null : s;
}

function inferMedicalByText(memo, categoryRaw) {
  const text = `${String(categoryRaw ?? "")} ${String(memo ?? "")}`.toLowerCase();
  if (!text.trim()) {
    return { isMedicalExpense: false, medicalType: null, medicalPatientName: null };
  }
  const medicine = /薬局|調剤|ドラッグ|マツキヨ|ウエルシア|スギ薬局|ココカラ/.test(text);
  const treatment = /病院|医院|クリニック|歯科|内科|外科|皮膚科|眼科|耳鼻|小児科|整形|医療/.test(text);
  if (!medicine && !treatment) {
    return { isMedicalExpense: false, medicalType: null, medicalPatientName: null };
  }
  return {
    isMedicalExpense: true,
    medicalType: medicine ? "medicine" : "treatment",
    medicalPatientName: "本人",
  };
}

const MEDICAL_TYPES = new Set(["treatment", "medicine", "other"]);

function normalizeMedicalType(raw) {
  if (raw == null || raw === "") return null;
  const v = String(raw).trim().toLowerCase();
  if (!MEDICAL_TYPES.has(v)) return null;
  return v;
}

function normalizeMedicalPatientName(raw) {
  if (raw == null || raw === "") return null;
  const v = String(raw).trim().slice(0, 120);
  return v === "" ? null : v;
}

function isMedicalFieldSpecified(body) {
  return (
    Object.prototype.hasOwnProperty.call(body, "is_medical_expense") ||
    Object.prototype.hasOwnProperty.call(body, "medical_type") ||
    Object.prototype.hasOwnProperty.call(body, "medical_patient_name")
  );
}

function hasAnyCategoryMedicalDefaultField(body) {
  return (
    Object.prototype.hasOwnProperty.call(body, "is_medical_default") ||
    Object.prototype.hasOwnProperty.call(body, "default_medical_type") ||
    Object.prototype.hasOwnProperty.call(body, "default_patient_name")
  );
}

async function resolveMedicalDefaultsFromCategory(pool, catWhere, userId, categoryId) {
  if (categoryId == null || !Number.isFinite(Number(categoryId))) {
    return { isMedicalExpense: false, medicalType: null, medicalPatientName: null };
  }
  const [[row]] = await pool.query(
    `SELECT c.is_medical_default, c.default_medical_type, c.default_patient_name
     FROM categories c
     WHERE c.id = ? AND (${catWhere}) AND c.is_archived = 0
     LIMIT 1`,
    [Number(categoryId), userId, userId],
  );
  if (!row || Number(row.is_medical_default) !== 1) {
    return { isMedicalExpense: false, medicalType: null, medicalPatientName: null };
  }
  return {
    isMedicalExpense: true,
    medicalType: normalizeMedicalType(row.default_medical_type),
    medicalPatientName: normalizeMedicalPatientName(row.default_patient_name),
  };
}

async function verifyUserInFamily(pool, userId, familyId) {
  if (familyId == null || !Number.isFinite(Number(familyId))) return false;
  const [rows] = await pool.query(
    `SELECT 1 AS ok FROM family_members WHERE family_id = ? AND user_id = ? LIMIT 1`,
    [familyId, userId],
  );
  return Array.isArray(rows) && rows.length > 0;
}

/** レシート summary.date 等を SQL DATE 比較用 YYYY-MM-DD に寄せる */
function normalizeReceiptDateForSql(raw) {
  const t = String(raw ?? "")
    .trim()
    .replace(/\//g, "-");
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (!m) return "";
  return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
}

const RECEIPT_CATEGORY_KEYWORDS = {
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
  daily: [
    "ティッシュ",
    "洗剤",
    "シャンプー",
    "リンス",
    "コンディショナー",
    "歯ブラシ",
    "トイレットペーパー",
    "日用品",
  ],
  transport: ["電車", "バス", "タクシー", "駐車", "ガソリン", "高速", "ic"],
  utility: ["電気", "ガス", "水道", "通信", "wifi", "インターネット", "携帯"],
  medical: ["薬", "病院", "診療", "処方", "クリニック"],
  leisure: ["映画", "カフェ", "外食", "レジャー", "趣味", "書籍"],
};

const RECEIPT_CATEGORY_ALIASES = {
  food: ["食費", "食品", "食料品", "飲食", "スーパー", "グロサリー", "grocery", "food"],
  daily: ["日用品", "雑貨", "生活用品", "ドラッグ", "ドラッグストア"],
  transport: ["交通", "交通費", "電車", "バス", "タクシー", "ガソリン", "駐車場"],
  utility: ["水道", "光熱費", "電気", "ガス", "通信", "ネット", "携帯"],
  medical: ["医療", "病院", "薬", "薬局", "ドラッグ"],
  leisure: ["娯楽", "交際", "外食", "趣味", "レジャー"],
};

/** 店舗名に現れやすい語（履歴の次に、明細キーワードより店舗を強く効かせる） */
const RECEIPT_VENDOR_TAG_HINTS = {
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

/**
 * 明細行テキスト向けの語彙（店名が弱くても効かせる・プレミアム用）。
 * RECEIPT_CATEGORY_KEYWORDS より細かく、明細のみに高い重みを付ける。
 */
const RECEIPT_LINE_ITEM_KEYWORDS = {
  daily: [
    "シャンプー",
    "リンス",
    "コンディショナー",
    "トリートメント",
    "ヘアパック",
    "ヘアマスク",
    "ボディソープ",
    "ボディーソープ",
    "ハンドソープ",
    "洗顔",
    "クレンジング",
    "化粧水",
    "乳液",
    "美容液",
    "日焼け止め",
    "uvケア",
    "柔軟剤",
    "漂白剤",
    "洗濯洗剤",
    "台所用洗剤",
    "食器用洗剤",
    "洗剤",
    "ティッシュ",
    "トイレットペーパー",
    "ウェットティッシュ",
    "おしりふき",
    "おむつ",
    "紙おむつ",
    "生理用品",
    "ナプキン",
    "歯ブラシ",
    "歯磨き",
    "ハミガキ",
    "歯みがき粉",
    "マウスウォッシュ",
    "カミソリ",
    "替刃",
    "シェービング",
    "除菌",
    "消臭",
    "除湿剤",
    "防虫",
    "ゴミ袋",
    "ラップ",
    "アルミホイル",
    "キッチンペーパー",
    "スポンジ",
    "雑巾",
    "マスク",
    "絆創膏",
    "消毒液",
    "体温計",
    "電池",
    "乾電池",
  ],
  food: [
    "牛乳",
    "ヨーグルト",
    "チーズ",
    "バター",
    "卵",
    "卵１０",
    "米",
    "パン",
    "食パン",
    "惣菜",
    "弁当",
    "おにぎり",
    "サンドイッチ",
    "ハム",
    "ベーコン",
    "ソーセージ",
    "野菜",
    "果物",
    "りんご",
    "バナナ",
    "豚肉",
    "牛肉",
    "鶏肉",
    "魚",
    "刺身",
    "寿司",
    "納豆",
    "豆腐",
    "味噌",
    "醤油",
    "ソース",
    "調味料",
    "スナック",
    "チョコ",
    "クッキー",
    "アイス",
    "ジュース",
    "お茶",
    "水２ｌ",
    "炭酸",
    "ビール",
    "発泡酒",
    "ワイン",
  ],
  medical: [
    "処方",
    "医薬品",
    "第１類",
    "第２類",
    "第３類",
    "鎮痛剤",
    "解熱",
    "かぜ薬",
    "胃腸薬",
    "整腸剤",
    "便秘薬",
    "目薬",
    "鼻炎",
    "湿布",
    "絆創膏",
    "消毒液",
    "マスク",
    "体温計",
    "検査",
    "診察",
  ],
  leisure: [
    "入場券",
    "チケット",
    "映画",
    "グッズ",
    "フィギュア",
    "トレカ",
    "ゲームソフト",
    "コミック",
    "雑誌",
    "書籍",
    "文房具",
    "ノート",
    "ペン",
  ],
  transport: ["定期", "チャージ", "１０００円券", "回数券", "パーク券", "駐車券", "etc"],
  utility: ["電気代", "ガス代", "水道代", "通信料", "プロバイダ", "ひかり", "ドコモ", "au", "ソフトバンク"],
};

/**
 * プレミアム: 明細の商品名だけでカテゴリタグを推し、ユーザー支出カテゴリにマッピングする。
 * 店名が弱いときはしきい値を緩める。
 * @returns {{ id: number; name: string; source: "line_items"; lowConfidence: boolean } | null}
 */
function suggestExpenseCategoryFromPremiumLineItems(items, userExpenseCategories, vendor) {
  const userCats = Array.isArray(userExpenseCategories) ? userExpenseCategories : [];
  if (userCats.length === 0) return null;
  const itemCorpus = normalizeKeyword((items ?? []).map((x) => x?.name ?? "").join(" "));
  if (!itemCorpus || itemCorpus.length < 2) return null;

  const vendorWeak =
    receiptVendorSignalWeak(vendor) || normalizeVendorName(vendor).length < 4;

  /** @type {Record<string, { score: number; hits: number }>} */
  const tagStats = {};
  for (const [tag, words] of Object.entries(RECEIPT_LINE_ITEM_KEYWORDS)) {
    let hits = 0;
    let score = 0;
    for (const w of words) {
      const nw = normalizeKeyword(w);
      if (!nw || nw.length < 2) continue;
      if (!itemCorpus.includes(nw)) continue;
      hits += 1;
      score += nw.length >= 4 ? 6 : 5;
    }
    if (hits > 0) tagStats[tag] = { score, hits };
  }

  let bestTag = null;
  let bestStat = null;
  for (const [tag, st] of Object.entries(tagStats)) {
    if (
      !bestStat ||
      st.score > bestStat.score ||
      (st.score === bestStat.score && st.hits > bestStat.hits)
    ) {
      bestTag = tag;
      bestStat = st;
    }
  }

  const minScore = vendorWeak ? 5 : 10;
  const minHits = vendorWeak ? 1 : 2;
  if (!bestTag || !bestStat || bestStat.score < minScore || bestStat.hits < minHits) return null;

  const matched = userCats.filter((r) => tagFromCategoryName(r.name) === bestTag);
  if (matched.length === 0) return null;
  const picked = matched[0];

  const lowConfidence = bestStat.score < 12 || bestStat.hits < 2;
  return {
    id: Number(picked.id),
    name: String(picked.name),
    source: "line_items",
    lowConfidence,
  };
}

function normalizeKeyword(s) {
  return String(s ?? "").toLowerCase().replace(/\s+/g, "").replace(/[　]/g, "");
}

function normalizeReceiptCategoryName(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[　・/]/g, "");
}

function pickCategoryIdByAiName(aiName, categoryRows) {
  const target = normalizeReceiptCategoryName(aiName);
  if (!target) return null;
  let partial = null;
  for (const r of categoryRows || []) {
    const nm = normalizeReceiptCategoryName(r?.name ?? "");
    if (!nm) continue;
    if (nm === target) return Number(r.id);
    if (!partial && (nm.includes(target) || target.includes(nm))) {
      partial = Number(r.id);
    }
  }
  return partial;
}

/**
 * 取込画面で保存した「名寄せ店名ラベル → 支出カテゴリ」（user_store_places）を Bedrock 補助JSONへ
 * @param {import("mysql2/promise").Pool} pool
 * @param {number|string} userId
 * @returns {Promise<Array<{ storeLabel: string, categoryName: string }>>}
 */
async function fetchUserVendorOcrKeyCategoryHints(pool, userId) {
  try {
    const [rows] = await pool.query(
      `SELECT u.display_name, c.name AS category_name
       FROM user_store_places u
       INNER JOIN categories c
         ON c.id = u.preferred_category_id
         AND c.kind = 'expense'
         AND c.is_archived = 0
         AND (c.family_id IN (SELECT family_id FROM family_members WHERE user_id = ?)
              OR (c.family_id IS NULL AND c.user_id = ?))
       WHERE u.user_id = ? AND u.preferred_category_id IS NOT NULL
         AND u.display_name IS NOT NULL AND TRIM(u.display_name) != ''
       ORDER BY u.updated_at DESC
       LIMIT 24`,
      [userId, userId, userId],
    );
    const out = [];
    for (const r of Array.isArray(rows) ? rows : []) {
      const sl = r.display_name != null ? String(r.display_name).trim() : "";
      const cn = r.category_name != null ? String(r.category_name).trim() : "";
      if (sl && cn) out.push({ storeLabel: sl, categoryName: cn });
    }
    return out;
  } catch {
    return [];
  }
}

function normalizeVendorName(s) {
  return normalizeKeyword(s)
    .replace(/株式会社/g, "")
    .replace(/\(株\)/g, "")
    .replace(/有限会社/g, "")
    .replace(/\(有\)/g, "");
}

function normalizeReceiptToken(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[　]/g, "");
}

function normalizeReceiptVendor(s) {
  return normalizeReceiptToken(s)
    .replace(/株式会社/g, "")
    .replace(/\(株\)/g, "")
    .replace(/有限会社/g, "")
    .replace(/\(有\)/g, "");
}

function buildReceiptItemSet(items) {
  const set = new Set();
  for (const it of Array.isArray(items) ? items : []) {
    const n = normalizeReceiptToken(it?.name ?? "");
    if (n) set.add(n);
  }
  return set;
}

function receiptItemOverlapScore(aItems, bItems) {
  const a = buildReceiptItemSet(aItems);
  const b = buildReceiptItemSet(bItems);
  if (a.size === 0 || b.size === 0) return 0;
  let hit = 0;
  for (const x of a) {
    if (b.has(x)) hit += 1;
  }
  return hit / Math.max(a.size, b.size);
}

async function findLearnedReceiptCorrection(pool, userId, catWhere, summary, items) {
  const mk = receiptOcrMatchKey(summary, items ?? []);
  const [exactRows] = await pool.query(
    `SELECT category_id, memo FROM receipt_ocr_corrections
     WHERE user_id = ? AND match_key = ? LIMIT 1`,
    [userId, mk],
  );
  const exact = Array.isArray(exactRows) ? exactRows[0] : null;
  if (exact) {
    return {
      hit: true,
      categoryId:
        exact.category_id != null && exact.category_id !== ""
          ? Number(exact.category_id)
          : null,
      memoPresent: exact.memo != null,
      memoValue: exact.memo != null ? String(exact.memo).slice(0, 500) : "",
      mode: "exact",
    };
  }

  const vendorNorm = normalizeReceiptVendor(summary?.vendorName ?? "");
  if (!vendorNorm) {
    return { hit: false, categoryId: null, memoPresent: false, memoValue: "", mode: null };
  }
  const [candRows] = await pool.query(
    `SELECT category_id, memo, ocr_snapshot_json
     FROM receipt_ocr_corrections
     WHERE user_id = ?
       AND (category_id IS NOT NULL OR memo IS NOT NULL)
     ORDER BY updated_at DESC
     LIMIT 200`,
    [userId],
  );
  if (!Array.isArray(candRows) || candRows.length === 0) {
    return { hit: false, categoryId: null, memoPresent: false, memoValue: "", mode: null };
  }
  let best = null;
  for (const row of candRows) {
    let snap = null;
    try {
      snap = JSON.parse(String(row.ocr_snapshot_json ?? "{}"));
    } catch {
      continue;
    }
    const sv = normalizeReceiptVendor(snap?.vendorName ?? "");
    if (!sv) continue;
    const vendorMatched = sv === vendorNorm || sv.includes(vendorNorm) || vendorNorm.includes(sv);
    if (!vendorMatched) continue;
    const overlap = receiptItemOverlapScore(items ?? [], snap?.items ?? []);
    const score = 10 + overlap * 5;
    if (!best || score > best.score) {
      best = { row, score };
    }
  }
  if (!best || best.score < 10.5) {
    return { hit: false, categoryId: null, memoPresent: false, memoValue: "", mode: null };
  }
  return {
    hit: true,
    categoryId:
      best.row.category_id != null && best.row.category_id !== ""
        ? Number(best.row.category_id)
        : null,
    memoPresent: best.row.memo != null,
    memoValue: best.row.memo != null ? String(best.row.memo).slice(0, 500) : "",
    mode: "vendor_fallback",
  };
}

/** 明細の金額合計（プレミアム検算用） */
function sumReceiptLineItemAmounts(items) {
  if (!Array.isArray(items)) return NaN;
  let s = 0;
  let any = false;
  for (const it of items) {
    const n = Number(it?.amount);
    if (Number.isFinite(n) && n > 0) {
      s += n;
      any = true;
    }
  }
  return any ? Math.round(s) : NaN;
}

/**
 * プレミアム: 印字合計と明細合計のずれを検算し、明細優先で補正することがある。
 * @returns {{ summary: Record<string, unknown>, adjusted: boolean, note: string | null }}
 */
function reconcilePremiumReceiptTotal(summary, items) {
  const base = summary && typeof summary === "object" ? { ...summary } : {};
  const lineSum = sumReceiptLineItemAmounts(items);
  if (!Number.isFinite(lineSum) || lineSum <= 0) {
    return { summary: base, adjusted: false, note: null };
  }
  const cur = Number(base.totalAmount ?? NaN);
  if (!Number.isFinite(cur) || cur <= 0) {
    return {
      summary: { ...base, totalAmount: lineSum },
      adjusted: true,
      note: `明細を検算し、合計金額を ${lineSum.toLocaleString("ja-JP")} 円としました。`,
    };
  }
  const diff = Math.abs(cur - lineSum);
  if (diff <= 1) return { summary: base, adjusted: false, note: null };
  const ratio = cur / lineSum;
  if (ratio < 0.95 || ratio > 1.08) {
    const prev = Math.round(cur);
    const next = lineSum;
    return {
      summary: { ...base, totalAmount: next },
      adjusted: true,
      note: `明細を検算し、合計金額を補正しました（¥${prev.toLocaleString("ja-JP")} → ¥${next.toLocaleString("ja-JP")}）。`,
    };
  }
  return { summary: base, adjusted: false, note: null };
}

const JP_PHONE_IN_OCR_RE = /0\d{1,4}-\d{1,4}-\d{4}|0\d{9,10}/;

function ocrLinesMayContainJapanPhone(ocrLines) {
  const text = Array.isArray(ocrLines) ? ocrLines.map((x) => String(x ?? "")).join("\n") : "";
  return JP_PHONE_IN_OCR_RE.test(text);
}

function receiptVendorSignalWeak(v) {
  const s = String(v ?? "").trim();
  if (s.length < 2) return true;
  if (/^(不明|unknown|不詳)$/i.test(s)) return true;
  if (/^[-_/|\s・。]+$/u.test(s)) return true;
  return false;
}

function tagFromCategoryName(name) {
  const n = normalizeKeyword(name);
  for (const [tag, aliases] of Object.entries(RECEIPT_CATEGORY_ALIASES)) {
    if (aliases.some((a) => n.includes(normalizeKeyword(a)))) return tag;
  }
  return null;
}

const RECEIPT_NORMALIZED_MEMO_EXPR =
  "LOWER(REPLACE(REPLACE(REPLACE(REPLACE(TRIM(t.memo), ' ', ''), '　', ''), '株式会社', ''), '(株)', ''))";
const RECEIPT_NORMALIZED_SNAPSHOT_VENDOR_EXPR =
  "LOWER(REPLACE(REPLACE(REPLACE(REPLACE(TRIM(JSON_UNQUOTE(JSON_EXTRACT(r.ocr_snapshot_json, '$.vendorName'))), ' ', ''), '　', ''), '株式会社', ''), '(株)', ''))";

/** 無料向け: 家族スコープの取引メモ（店名）一致で直近の支出カテゴリ */
async function suggestExpenseCategoryFromTransactionHistory(pool, userId, txWhere, vendor, txWhereParams) {
  const memo = String(vendor ?? "").trim();
  if (!memo) return null;
  const normMemo = normalizeVendorName(memo);
  if (!normMemo) return null;
  const p =
    Array.isArray(txWhereParams) && txWhereParams.length > 0 ? txWhereParams : [userId, userId];

  const [rows] = await pool.query(
    `SELECT t.category_id, c.name, t.transaction_date, t.id
     FROM transactions t
     JOIN categories c ON c.id = t.category_id
     WHERE ${txWhere}
       AND t.kind = 'expense'
       AND t.category_id IS NOT NULL
       AND c.kind = 'expense'
       AND c.is_archived = 0
       AND ${RECEIPT_NORMALIZED_MEMO_EXPR} = ?
     ORDER BY t.transaction_date DESC, t.id DESC
     LIMIT 1`,
    [...p, normMemo],
  );
  if (Array.isArray(rows) && rows[0]?.category_id != null) {
    const top = rows[0];
    return {
      id: Number(top.category_id),
      name: String(top.name),
      source: "history",
    };
  }
  return null;
}

/** プレミアム: 家族内のレシート補正履歴（同一店名の最新 category）を最優先 */
async function suggestExpenseCategoryFromFamilyReceiptCorrections(
  pool,
  userId,
  familyId,
  vendor,
  userExpenseCategories,
) {
  const memo = String(vendor ?? "").trim();
  if (!memo) return null;
  const normMemo = normalizeVendorName(memo);
  if (!normMemo) return null;
  const catRows = Array.isArray(userExpenseCategories) ? userExpenseCategories : [];
  if (catRows.length === 0) return null;
  const byId = new Map(catRows.map((c) => [Number(c.id), c]));
  const byName = new Map(catRows.map((c) => [normalizeCategoryNameKey(c.name), c]));
  const hasFamily = Number.isFinite(Number(familyId)) && Number(familyId) > 0;
  const scopeSql = hasFamily ? "(r.user_id = ? OR r.family_id = ?)" : "r.user_id = ?";
  const params = hasFamily ? [userId, Number(familyId), normMemo] : [userId, normMemo];

  const [rows] = await pool.query(
    `SELECT r.category_id, c.name AS category_name
     FROM receipt_ocr_corrections r
     LEFT JOIN categories c ON c.id = r.category_id
     WHERE ${scopeSql}
       AND r.category_id IS NOT NULL
       AND JSON_VALID(r.ocr_snapshot_json)
       AND ${RECEIPT_NORMALIZED_SNAPSHOT_VENDOR_EXPR} = ?
     ORDER BY r.updated_at DESC, r.id DESC
     LIMIT 20`,
    params,
  );
  if (!Array.isArray(rows) || rows.length === 0) return null;
  for (const row of rows) {
    const categoryId = row?.category_id != null ? Number(row.category_id) : null;
    if (categoryId != null && byId.has(categoryId)) {
      const hit = byId.get(categoryId);
      return { id: Number(hit.id), name: String(hit.name), source: "history" };
    }
    const categoryName = String(row?.category_name ?? "").trim();
    if (!categoryName) continue;
    const byNameHit = byName.get(normalizeCategoryNameKey(categoryName));
    if (byNameHit?.id != null) {
      return { id: Number(byNameHit.id), name: String(byNameHit.name), source: "history" };
    }
  }
  return null;
}

/**
 * プレミアム: 初期投入のチェーン店名辞書（vendor_norm の最長一致）→ カテゴリ名ヒント → ユーザー ID へ解決
 */
async function suggestExpenseCategoryFromStaticChainCatalog(pool, vendor, userExpenseCategories) {
  const norm = normalizeVendorName(vendor);
  if (!norm || norm.length < 3) return null;
  const userCats = Array.isArray(userExpenseCategories) ? userExpenseCategories : [];
  if (userCats.length === 0) return null;
  try {
    const [rows] = await pool.query(
      `SELECT category_name_hint, weight
       FROM static_chain_store_category_hints
       WHERE ? LIKE CONCAT(vendor_norm, '%')
         AND CHAR_LENGTH(vendor_norm) >= 3
       ORDER BY CHAR_LENGTH(vendor_norm) DESC, weight DESC, id ASC
       LIMIT 12`,
      [norm],
    );
    if (!Array.isArray(rows) || rows.length === 0) return null;
    for (const row of rows) {
      const hint = String(row?.category_name_hint ?? "").trim();
      if (!hint) continue;
      const hintKey = normalizeCategoryNameKey(hint);
      const hit = userCats.find((c) => normalizeCategoryNameKey(c.name) === hintKey);
      if (hit?.id != null) {
        return { id: Number(hit.id), name: String(hit.name), source: "chain_catalog" };
      }
      const partial = userCats.find(
        (c) =>
          normalizeCategoryNameKey(c.name).includes(hintKey) ||
          hintKey.includes(normalizeCategoryNameKey(c.name)),
      );
      if (partial?.id != null) {
        return { id: Number(partial.id), name: String(partial.name), source: "chain_catalog" };
      }
    }
  } catch (e) {
    const code = e && typeof e === "object" && "code" in e ? String(e.code) : "";
    if (code !== "ER_NO_SUCH_TABLE") {
      logError("receipts.parse.static_chain_catalog", e);
    }
  }
  return null;
}

async function suggestExpenseCategoryFromGlobalMaster(pool, vendor, userExpenseCategories) {
  const memo = String(vendor ?? "").trim();
  if (!memo) return null;
  const normMemo = normalizeVendorName(memo);
  if (!normMemo) return null;
  const userCats = Array.isArray(userExpenseCategories) ? userExpenseCategories : [];
  if (userCats.length === 0) return null;
  const [rows] = await pool.query(
    `SELECT c.name AS global_category_name, COUNT(*) AS used_count
     FROM receipt_ocr_corrections r
     JOIN categories c ON c.id = r.category_id
     WHERE r.category_id IS NOT NULL
       AND c.kind = 'expense'
       AND JSON_VALID(r.ocr_snapshot_json)
       AND ${RECEIPT_NORMALIZED_SNAPSHOT_VENDOR_EXPR} = ?
     GROUP BY c.name
     ORDER BY used_count DESC, MAX(r.updated_at) DESC, c.name ASC
     LIMIT 12`,
    [normMemo],
  );
  if (!Array.isArray(rows) || rows.length === 0) return null;
  for (const r of rows) {
    const globalName = String(r.global_category_name ?? "").trim();
    if (!globalName) continue;
    const nk = normalizeCategoryNameKey(globalName);
    const hit = userCats.find((c) => normalizeCategoryNameKey(c.name) === nk);
    if (hit?.id != null) {
      return { id: Number(hit.id), name: String(hit.name), source: "global_master" };
    }
  }
  return null;
}

async function suggestExpenseCategoryForReceipt(
  pool,
  userId,
  catWhere,
  txWhere,
  vendor,
  items,
  { usePersonalHistory = true, familyId = null, expenseCategories = null, txWhereParams = null } = {},
) {
  const twp =
    Array.isArray(txWhereParams) && txWhereParams.length > 0 ? txWhereParams : [userId, userId];
  if (usePersonalHistory) {
    const fromTx = await suggestExpenseCategoryFromTransactionHistory(
      pool,
      userId,
      txWhere,
      vendor,
      twp,
    );
    if (fromTx?.id) return fromTx;
  }

  const vend = normalizeKeyword(vendor ?? "");
  const itemCorpus = normalizeKeyword((items ?? []).map((x) => x?.name ?? "").join(" "));
  if (!vend && !itemCorpus) return null;
  const rows =
    Array.isArray(expenseCategories) && expenseCategories.length > 0
      ? expenseCategories
      : (
          await pool.query(
            `SELECT c.id, c.name
             FROM categories c
             WHERE ${catWhere} AND c.is_archived = 0 AND c.kind = 'expense'
             ORDER BY c.sort_order, c.id`,
            [userId, userId],
          )
        )[0];
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const tagScore = {};
  for (const [tag, words] of Object.entries(RECEIPT_CATEGORY_KEYWORDS)) {
    let score = 0;
    for (const w of words) {
      const nw = normalizeKeyword(w);
      if (!nw) continue;
      if (itemCorpus.includes(nw)) score += 3;
      if (vend.includes(nw)) score += 1;
    }
    if (score > 0) tagScore[tag] = (tagScore[tag] ?? 0) + score;
  }
  for (const [tag, words] of Object.entries(RECEIPT_VENDOR_TAG_HINTS)) {
    for (const w of words) {
      const nw = normalizeKeyword(w);
      if (nw && vend.includes(nw)) {
        tagScore[tag] = (tagScore[tag] ?? 0) + 4;
      }
    }
  }

  let best = null;
  for (const r of rows) {
    const tag = tagFromCategoryName(r.name);
    const score = tag ? (tagScore[tag] ?? 0) : 0;
    if (!best || score > best.score) {
      best = { id: Number(r.id), name: String(r.name), score };
    }
  }
  if (!best || best.score <= 0) return null;
  return { id: best.id, name: best.name, source: "keywords" };
}

async function predictCategory({
  pool,
  userId,
  familyId,
  txWhere,
  txWhereParams,
  vendor,
  items,
  userExpenseCategories,
  subscriptionActive,
  aiCategoryName,
}) {
  const twp =
    Array.isArray(txWhereParams) && txWhereParams.length > 0 ? txWhereParams : [userId, userId];
  if (subscriptionActive) {
    const fromFamilyCorr = await suggestExpenseCategoryFromFamilyReceiptCorrections(
      pool,
      userId,
      familyId,
      vendor,
      userExpenseCategories,
    );
    if (fromFamilyCorr?.id != null) {
      return { ...fromFamilyCorr, lowConfidence: false };
    }
    const fromStatic = await suggestExpenseCategoryFromStaticChainCatalog(
      pool,
      vendor,
      userExpenseCategories,
    );
    if (fromStatic?.id != null) {
      return { ...fromStatic, lowConfidence: false };
    }
    const fromGlobal = await suggestExpenseCategoryFromGlobalMaster(
      pool,
      vendor,
      userExpenseCategories,
    );
    if (fromGlobal?.id != null) {
      return { ...fromGlobal, lowConfidence: false };
    }
    const fromLineItems = suggestExpenseCategoryFromPremiumLineItems(
      items,
      userExpenseCategories,
      vendor,
    );
    if (fromLineItems?.id != null) {
      return {
        id: fromLineItems.id,
        name: fromLineItems.name,
        source: "line_items",
        lowConfidence: Boolean(fromLineItems.lowConfidence),
      };
    }
  } else {
    const fromTx = await suggestExpenseCategoryFromTransactionHistory(
      pool,
      userId,
      txWhere,
      vendor,
      twp,
    );
    if (fromTx?.id != null) {
      return { ...fromTx, lowConfidence: false };
    }
  }
  const fromKeywords = await suggestExpenseCategoryForReceipt(
    pool,
    userId,
    "1=1",
    txWhere,
    vendor,
    items,
    {
      usePersonalHistory: false,
      familyId,
      expenseCategories: userExpenseCategories,
      txWhereParams: twp,
    },
  );
  if (fromKeywords?.id != null) {
    return { ...fromKeywords, lowConfidence: true };
  }
  if (subscriptionActive && aiCategoryName) {
    const aiNorm = normalizeCategoryNameKey(aiCategoryName);
    const hit = (Array.isArray(userExpenseCategories) ? userExpenseCategories : []).find(
      (c) => normalizeCategoryNameKey(c.name) === aiNorm,
    );
    if (hit?.id != null) {
      return {
        id: Number(hit.id),
        name: String(hit.name),
        source: "ai",
        lowConfidence: true,
      };
    }
    return { id: null, name: String(aiCategoryName), source: "ai", lowConfidence: true };
  }
  return { id: null, name: null, source: null, lowConfidence: false };
}

function isUnknownIsPremiumColumnError(e) {
  if (!e || typeof e !== "object") return false;
  const code = e.code ? String(e.code) : "";
  const errno = Number(e.errno);
  const msg = String(e.message || "");
  return (
    (code === "ER_BAD_FIELD_ERROR" || errno === 1054) &&
    msg.includes("is_premium")
  );
}

function isUnknownSubscriptionColumnError(e) {
  if (!e || typeof e !== "object") return false;
  const code = e.code ? String(e.code) : "";
  const errno = Number(e.errno);
  const msg = String(e.message || "");
  const okCode = code === "ER_BAD_FIELD_ERROR" || errno === 1054;
  if (!okCode) return false;
  // エラーメッセージに SQL 断片だけが載る環境での誤検知を避ける（本当の Unknown column のみ）
  if (!/unknown column/i.test(msg)) return false;
  return msg.includes("subscription_status");
}

/**
 * 実 DB に subscription_status 列があるか（一覧用の誤検知を防ぐ）
 */
async function probeUsersSubscriptionStatusColumnPresent(pool) {
  try {
    await pool.query(`SELECT subscription_status FROM users WHERE 1=0`);
    return true;
  } catch {
    return false;
  }
}

async function probeFamiliesSubscriptionColumnsPresent(pool) {
  try {
    await pool.query(
      `SELECT subscription_status, stripe_customer_id FROM families WHERE 1=0`,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * 管理一覧と同じ並び・件数で subscription_status のみ取得してマップ化
 */
async function fetchAdminUsersSubscriptionStatusMap(pool) {
  const useFamily = await probeFamiliesSubscriptionColumnsPresent(pool);
  let subRows;
  if (useFamily) {
    const [rows] = await pool.query(
      `SELECT u.id,
        COALESCE(f.subscription_status, u.subscription_status) AS subscription_status
       FROM users u
       LEFT JOIN families f ON f.id = ${FAM_JOIN_ADMIN}
       ORDER BY u.id ASC
       LIMIT 1000`,
    );
    subRows = rows;
  } else {
    const [rows] = await pool.query(
      `SELECT id, subscription_status FROM users ORDER BY id ASC LIMIT 1000`,
    );
    subRows = rows;
  }
  const map = new Map();
  if (Array.isArray(subRows)) {
    for (const r of subRows) {
      map.set(Number(r.id), r.subscription_status);
    }
  }
  return map;
}

/** users.last_accessed_at（v33）を id->値 の Map で取得。未適用DBは空Map。 */
async function fetchAdminUsersLastAccessedAtMap(pool) {
  try {
    const [rows] = await pool.query(
      `SELECT id, last_accessed_at FROM users ORDER BY id ASC LIMIT 1000`,
    );
    const map = new Map();
    if (Array.isArray(rows)) {
      for (const r of rows) {
        map.set(Number(r.id), r.last_accessed_at ?? null);
      }
    }
    return map;
  } catch (e) {
    if (isErBadFieldErrorAppCore(e)) return new Map();
    throw e;
  }
}

let warnedAdminUsersListSubscriptionColumnMissing = false;

const FAM_JOIN_ADMIN = sqlUserFamilyIdExpr("u");

/** v12 未適用時のフォールバック（users.subscription_status のみ） */
const ADMIN_USERS_LIST_SQL_WITH_SUB_LEGACY = `SELECT
           u.id,
           u.email,
           u.login_name,
           u.display_name,
           u.is_admin,
           u.subscription_status,
           u.created_at,
           u.updated_at,
           u.last_login_at,
           u.default_family_id,
           COALESCE(u.family_role, 'MEMBER') AS family_role,
           u.kid_theme AS kid_theme,
           (
             SELECT GROUP_CONCAT(
               CONCAT(
                 COALESCE(NULLIF(TRIM(u2.display_name), ''), u2.email),
                 ' (', fm2.role, ')'
               )
               ORDER BY fm2.id
               SEPARATOR '\n'
             )
             FROM family_members fm2
             JOIN users u2 ON u2.id = fm2.user_id
             WHERE u.default_family_id IS NOT NULL
               AND fm2.family_id = u.default_family_id
           ) AS family_peers
         FROM users u
         LEFT JOIN families f ON f.id = u.default_family_id
         ORDER BY (u.default_family_id IS NULL), u.default_family_id ASC, u.id ASC
         LIMIT 1000`;

const ADMIN_USERS_LIST_SQL_WITH_SUB = `SELECT
           u.id,
           u.email,
           u.login_name,
           u.display_name,
           u.is_admin,
           COALESCE(f.subscription_status, u.subscription_status) AS subscription_status,
           u.created_at,
           u.updated_at,
           u.last_login_at,
           u.default_family_id,
           COALESCE(u.family_role, 'MEMBER') AS family_role,
           u.kid_theme AS kid_theme,
           (
             SELECT GROUP_CONCAT(
               CONCAT(
                 COALESCE(NULLIF(TRIM(u2.display_name), ''), u2.email),
                 ' (', fm2.role, ')'
               )
               ORDER BY fm2.id
               SEPARATOR '\n'
             )
             FROM family_members fm2
             JOIN users u2 ON u2.id = fm2.user_id
             WHERE u.default_family_id IS NOT NULL
               AND fm2.family_id = u.default_family_id
           ) AS family_peers
         FROM users u
         LEFT JOIN families f ON f.id = ${FAM_JOIN_ADMIN}
         ORDER BY (u.default_family_id IS NULL), u.default_family_id ASC, u.id ASC
         LIMIT 1000`;

const ADMIN_USERS_LIST_SQL_WITHOUT_SUB = `SELECT
           u.id,
           u.email,
           u.login_name,
           u.display_name,
           u.is_admin,
           u.created_at,
           u.updated_at,
           u.last_login_at,
           u.default_family_id,
           COALESCE(u.family_role, 'MEMBER') AS family_role,
           u.kid_theme AS kid_theme,
           (
             SELECT GROUP_CONCAT(
               CONCAT(
                 COALESCE(NULLIF(TRIM(u2.display_name), ''), u2.email),
                 ' (', fm2.role, ')'
               )
               ORDER BY fm2.id
               SEPARATOR '\n'
             )
             FROM family_members fm2
             JOIN users u2 ON u2.id = fm2.user_id
             WHERE u.default_family_id IS NOT NULL
               AND fm2.family_id = u.default_family_id
           ) AS family_peers
         FROM users u
         LEFT JOIN families f ON f.id = ${FAM_JOIN_ADMIN}
         ORDER BY (u.default_family_id IS NULL), u.default_family_id ASC, u.id ASC
         LIMIT 1000`;

/**
 * 管理画面ユーザー一覧の「家族ID」列: 少なくとも1人の users.default_family_id がその families.id と一致する。
 * サポートチャット管理の家族一覧はこの条件で絞る（families だけ残っている孤立行を除外）
 */
async function familyIsInAdminUserDirectory(pool, familyId) {
  const fid = Number(familyId);
  if (!Number.isFinite(fid) || fid <= 0) return false;
  const [[row]] = await pool.query(
    `SELECT 1 AS ok FROM users WHERE default_family_id = ? LIMIT 1`,
    [fid],
  );
  return Boolean(row);
}

/**
 * 管理者一覧: subscription_status 列の有無はプローブで決め、列があるときは常に 2 クエリで取得する。
 * （1 本の複合 SELECT だけが環境依存で失敗し meta が誤って false になるのを防ぐ）
 * @returns {Promise<{ rows: unknown[]; subscriptionStatusWritable: boolean }>}
 */
async function fetchAdminUsersListRows(pool) {
  const columnPresent = await probeUsersSubscriptionStatusColumnPresent(pool);

  if (!columnPresent) {
    if (!warnedAdminUsersListSubscriptionColumnMissing) {
      warnedAdminUsersListSubscriptionColumnMissing = true;
      logger.warn(
        "admin.users: subscription_status column missing; apply db/migration_v8_users_subscription_status.sql",
        { event: "admin.users.subscription_column_missing" },
      );
    }
    const [rows] = await pool.query(ADMIN_USERS_LIST_SQL_WITHOUT_SUB);
    const accessMap = await fetchAdminUsersLastAccessedAtMap(pool);
    const listRaw = Array.isArray(rows) ? rows : [];
    return {
      rows: listRaw.map((r) => ({
        ...r,
        last_accessed_at: accessMap.has(Number(r.id)) ? accessMap.get(Number(r.id)) : null,
      })),
      subscriptionStatusWritable: false,
    };
  }

  const [rows] = await pool.query(ADMIN_USERS_LIST_SQL_WITHOUT_SUB);
  const accessMap = await fetchAdminUsersLastAccessedAtMap(pool);
  const list = Array.isArray(rows) ? rows : [];
  let subMap;
  try {
    subMap = await fetchAdminUsersSubscriptionStatusMap(pool);
  } catch (e) {
    logger.warn("admin.users: subscription_status map query failed; falling back to combined SELECT", {
      message: String(e?.message || e),
      code: e?.code,
      errno: e?.errno,
    });
    const useFamSub = await probeFamiliesSubscriptionColumnsPresent(pool);
    const [rowsWith] = await pool.query(
      useFamSub ? ADMIN_USERS_LIST_SQL_WITH_SUB : ADMIN_USERS_LIST_SQL_WITH_SUB_LEGACY,
    );
    const accessMapFallback = await fetchAdminUsersLastAccessedAtMap(pool);
    const listFallback = Array.isArray(rowsWith) ? rowsWith : [];
    return {
      rows: listFallback.map((r) => ({
        ...r,
        last_accessed_at: accessMapFallback.has(Number(r.id))
          ? accessMapFallback.get(Number(r.id))
          : null,
      })),
      subscriptionStatusWritable: true,
    };
  }

  const merged = list.map((r) => {
    const sid = Number(r.id);
    const lastAccessedAt = accessMap.has(sid) ? accessMap.get(sid) : null;
    if (!subMap.has(sid)) {
      return { ...r, subscription_status: null, last_accessed_at: lastAccessedAt };
    }
    return { ...r, subscription_status: subMap.get(sid), last_accessed_at: lastAccessedAt };
  });

  return {
    rows: merged,
    subscriptionStatusWritable: true,
  };
}

function isErBadFieldErrorAppCore(e) {
  if (!e || typeof e !== "object") return false;
  const code = String(e.code || "");
  const errno = Number(e.errno);
  return code === "ER_BAD_FIELD_ERROR" || errno === 1054;
}

let warnedLastAccessedAtColumnMissing = false;

/**
 * 認証済みAPIの利用実績: 15分以上経過したときだけ users.last_accessed_at を更新。
 * 更新頻度を抑えて DB 負荷を避ける。
 */
async function touchUserLastAccessedAt(pool, userId) {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) return;
  try {
    await pool.query(
      `UPDATE users
       SET last_accessed_at = NOW(), updated_at = NOW()
       WHERE id = ?
         AND (last_accessed_at IS NULL OR last_accessed_at < (NOW() - INTERVAL 15 MINUTE))`,
      [uid],
    );
  } catch (e) {
    if (isErBadFieldErrorAppCore(e)) {
      if (!warnedLastAccessedAtColumnMissing) {
        warnedLastAccessedAtColumnMissing = true;
        logger.warn(
          "users.last_accessed_at column missing; apply db/migration_v33_users_last_accessed_at.sql",
          { event: "users.last_accessed_at.missing" },
        );
      }
      return;
    }
    throw e;
  }
}

/** users.family_role（未移行 DB は MEMBER 扱い） */
async function resolveUserFamilyRoleUpper(pool, userId) {
  try {
    const [[row]] = await pool.query(
      `SELECT COALESCE(family_role, 'MEMBER') AS fr FROM users WHERE id = ? LIMIT 1`,
      [userId],
    );
    const v = String(row?.fr ?? "MEMBER")
      .trim()
      .toUpperCase();
    if (v === "KID" || v === "ADMIN") return v;
    return "MEMBER";
  } catch (e) {
    if (isErBadFieldErrorAppCore(e)) return "MEMBER";
    throw e;
  }
}

async function isFamilyOwnerMember(pool, userId, familyId) {
  try {
    const [[row]] = await pool.query(
      `SELECT role FROM family_members WHERE user_id = ? AND family_id = ? LIMIT 1`,
      [userId, familyId],
    );
    return String(row?.role ?? "")
      .trim()
      .toLowerCase() === "owner";
  } catch {
    return false;
  }
}

/**
 * 保護者が ?ledger_view=kid_watch で子の家族取引のみ参照するモード（scope=family と併用）。
 * KID ログイン時はパラメータが付いていても無視（403 にしない）。
 */
async function resolveParentKidWatchLedger(pool, q, viewerId, familyRoleUpper, hdrs, skipCors) {
  const ledgerRaw = String(q.ledger_view ?? q.ledgerView ?? "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  const wants =
    ledgerRaw === "kid_watch" ||
    String(q.kid_watch ?? "").trim() === "1" ||
    String(q.kidWatch ?? "")
      .trim()
      .toLowerCase() === "true";
  if (!wants) return { active: false, kidUserId: null, error: null };
  const role = String(familyRoleUpper || "MEMBER").toUpperCase();
  if (role === "KID" || (role !== "ADMIN" && role !== "MEMBER")) {
    return { active: false, kidUserId: null, error: null };
  }
  const rawKid = q.kid_user_id ?? q.kidUserId ?? q.kid_user ?? null;
  let kidUserId = null;
  if (rawKid != null && String(rawKid).trim() !== "") {
    const n = Number(rawKid);
    if (!Number.isFinite(n) || n <= 0) {
      return {
        active: false,
        kidUserId: null,
        error: json(400, { error: "kid_user_id（kidUserId）が不正です。" }, hdrs, skipCors),
      };
    }
    const [[row]] = await pool.query(
      `SELECT 1 AS ok
       FROM users u
       INNER JOIN family_members fm ON fm.user_id = u.id
       WHERE u.id = ?
         AND UPPER(TRIM(COALESCE(u.family_role, 'MEMBER'))) = 'KID'
         AND fm.family_id IN (SELECT family_id FROM family_members WHERE user_id = ?)
       LIMIT 1`,
      [n, viewerId],
    );
    if (!row?.ok) {
      return {
        active: false,
        kidUserId: null,
        error: json(
          400,
          { error: "指定したユーザーは、同一家族の KID として見つかりません。" },
          hdrs,
          skipCors,
        ),
      };
    }
    kidUserId = n;
  }
  return { active: true, kidUserId, error: null };
}

function normalizeAdminFamilyRole(raw) {
  const s = String(raw ?? "").trim().toUpperCase();
  if (s === "ADMIN" || s === "MEMBER" || s === "KID") return s;
  return null;
}

function normalizeAdminKidTheme(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const s = String(raw).trim().toLowerCase();
  if (
    s === "pink" ||
    s === "lavender" ||
    s === "pastel_yellow" ||
    s === "mint_green" ||
    s === "floral" ||
    s === "blue" ||
    s === "navy" ||
    s === "dino_green" ||
    s === "space_black" ||
    s === "sky_red"
  ) {
    return s;
  }
  return "__invalid__";
}

async function loadUserSubscriptionRowFull(pool, userId) {
  const queries = [
    `SELECT
      CASE
        WHEN LOWER(TRIM(COALESCE(f.subscription_status, ''))) IN ('admin_free','admin_granted')
             OR LOWER(TRIM(COALESCE(u.subscription_status, ''))) IN ('admin_free','admin_granted')
          THEN 'admin_free'
        WHEN LOWER(COALESCE(f.subscription_status, '')) IN ('active','trialing','past_due') THEN f.subscription_status
        WHEN LOWER(COALESCE(u.subscription_status, '')) IN ('active','trialing','past_due') THEN u.subscription_status
        ELSE COALESCE(f.subscription_status, u.subscription_status)
      END AS subscription_status,
      u.is_premium,
      CASE
        WHEN LOWER(TRIM(COALESCE(f.subscription_status, ''))) IN ('admin_free','admin_granted')
             OR LOWER(TRIM(COALESCE(u.subscription_status, ''))) IN ('admin_free','admin_granted')
          THEN COALESCE(f.subscription_period_end_at, u.subscription_period_end_at)
        WHEN LOWER(COALESCE(f.subscription_status, '')) IN ('active','trialing','past_due','admin_free','admin_granted') THEN f.subscription_period_end_at
        WHEN LOWER(COALESCE(u.subscription_status, '')) IN ('active','trialing','past_due','admin_free','admin_granted') THEN u.subscription_period_end_at
        ELSE COALESCE(f.subscription_period_end_at, u.subscription_period_end_at)
      END AS subscription_period_end_at,
      CASE
        WHEN LOWER(TRIM(COALESCE(f.subscription_status, ''))) IN ('admin_free','admin_granted')
             OR LOWER(TRIM(COALESCE(u.subscription_status, ''))) IN ('admin_free','admin_granted')
          THEN COALESCE(f.subscription_cancel_at_period_end, u.subscription_cancel_at_period_end)
        WHEN LOWER(COALESCE(f.subscription_status, '')) IN ('active','trialing','past_due','admin_free','admin_granted') THEN f.subscription_cancel_at_period_end
        WHEN LOWER(COALESCE(u.subscription_status, '')) IN ('active','trialing','past_due','admin_free','admin_granted') THEN u.subscription_cancel_at_period_end
        ELSE COALESCE(f.subscription_cancel_at_period_end, u.subscription_cancel_at_period_end)
      END AS subscription_cancel_at_period_end
     FROM users u
     LEFT JOIN families f ON f.id = ${FAM_JOIN_ADMIN}
     WHERE u.id = ? LIMIT 1`,
    `SELECT subscription_status, is_premium, subscription_period_end_at, subscription_cancel_at_period_end FROM users WHERE id = ? LIMIT 1`,
    `SELECT subscription_status, is_premium FROM users WHERE id = ? LIMIT 1`,
    `SELECT subscription_status FROM users WHERE id = ? LIMIT 1`,
  ];
  let lastErr;
  for (const sql of queries) {
    try {
      const [rows] = await pool.query(sql, [userId]);
      if (!Array.isArray(rows) || rows.length === 0) return {};
      return rows[0];
    } catch (e) {
      lastErr = e;
      if (!isErBadFieldErrorAppCore(e)) throw e;
    }
  }
  logger.warn("subscription_status column missing; defaulting to inactive", {
    userId,
    lastErr: String(lastErr?.message || lastErr),
  });
  return {};
}

/**
 * サブスク有料レシートAI向け: 家族スコープの最近の支出メモをヒントに渡す。
 */
async function fetchReceiptSubscriptionHistoryHints(pool, userId, txWhere, limit = 48, txWhereParams) {
  const lim = Math.min(80, Math.max(8, Number(limit) || 48));
  const p =
    Array.isArray(txWhereParams) && txWhereParams.length > 0 ? txWhereParams : [userId, userId];
  const [rows] = await pool.query(
    `SELECT t.transaction_date AS d, t.memo, t.amount, c.name AS category_name
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     WHERE ${txWhere}
       AND t.kind = 'expense'
       AND TRIM(COALESCE(t.memo, '')) <> ''
     ORDER BY t.transaction_date DESC, t.id DESC
     LIMIT ?`,
    [...p, lim],
  );
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({
    date: r.d ? String(r.d).slice(0, 10) : "",
    memo: r.memo != null ? String(r.memo).trim().slice(0, 200) : "",
    amount: r.amount != null ? String(r.amount) : "",
    categoryName:
      r.category_name != null ? String(r.category_name).trim().slice(0, 100) : null,
  }));
}

/**
 * よく使う店名メモ（memo）とカテゴリの頻出ペア — LLM のカテゴリ文脈用
 */
async function fetchTopMemoCategoryPairs(pool, userId, txWhere, txWhereParams, limit = 40) {
  const lim = Math.min(60, Math.max(5, Number(limit) || 40));
  const p =
    Array.isArray(txWhereParams) && txWhereParams.length > 0 ? txWhereParams : [userId, userId];
  const [rows] = await pool.query(
    `SELECT t.memo, c.name AS category_name, COUNT(*) AS cnt
     FROM transactions t
     INNER JOIN categories c ON c.id = t.category_id
     WHERE ${txWhere}
       AND t.kind = 'expense'
       AND TRIM(COALESCE(t.memo, '')) <> ''
     GROUP BY t.memo, c.id, c.name
     ORDER BY cnt DESC
     LIMIT ?`,
    [...p, lim],
  );
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({
    memo: r.memo != null ? String(r.memo).trim().slice(0, 200) : "",
    categoryName: r.category_name != null ? String(r.category_name).trim().slice(0, 100) : "",
    count: Math.min(100000, Number(r.cnt) || 0),
  }));
}

function tokenizeMemo(text) {
  const s = normalizeKeyword(text);
  if (!s) return [];
  const chunks = s
    .split(/[\/・,，\-_()\[\]【】]/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (chunks.length > 0) return chunks;
  return [s];
}

async function suggestExpenseCategoryForMemo(
  pool,
  userId,
  catWhere,
  txWhere,
  familyId,
  memo,
  expenseCategories,
  subscriptionActive,
  txWhereParams,
) {
  const twp =
    Array.isArray(txWhereParams) && txWhereParams.length > 0 ? txWhereParams : [userId, userId];
  const vendor = String(memo ?? "").trim();
  if (!vendor) return null;
  const cats =
    Array.isArray(expenseCategories) && expenseCategories.length > 0
      ? expenseCategories
      : (
          await pool.query(
            `SELECT c.id, c.name
             FROM categories c
             WHERE ${catWhere} AND c.is_archived = 0 AND c.kind = 'expense'
             ORDER BY c.sort_order, c.id`,
            [userId, userId],
          )
        )[0];
  if (subscriptionActive) {
    const fromFamilyCorr = await suggestExpenseCategoryFromFamilyReceiptCorrections(
      pool,
      userId,
      familyId,
      vendor,
      cats,
    );
    if (fromFamilyCorr?.id) return fromFamilyCorr;
    const fromStatic = await suggestExpenseCategoryFromStaticChainCatalog(pool, vendor, cats);
    if (fromStatic?.id) return fromStatic;
    const fromGlobal = await suggestExpenseCategoryFromGlobalMaster(pool, vendor, cats);
    if (fromGlobal?.id) return fromGlobal;
  } else {
    const fromTx = await suggestExpenseCategoryFromTransactionHistory(
      pool,
      userId,
      txWhere,
      vendor,
      twp,
    );
    if (fromTx?.id) return fromTx;
  }
  const tokens = tokenizeMemo(vendor).map((name) => ({ name, amount: null }));
  return suggestExpenseCategoryForReceipt(pool, userId, catWhere, txWhere, vendor, tokens, {
    usePersonalHistory: false,
    familyId,
    expenseCategories: cats,
    txWhereParams: twp,
  });
}

/**
 * 同一種別・正規化名の既存カテゴリ ID（あれば）。excludeId は PATCH 時に自分自身を除く。
 */
async function findDuplicateCategoryId(pool, userId, catWhere, kind, rawName, excludeId) {
  const nm = String(rawName ?? "").trim();
  if (!nm) return null;
  const want = normalizeCategoryNameKey(nm);
  const [rows] = await pool.query(
    `SELECT c.id, c.name FROM categories c
     WHERE ${catWhere} AND c.is_archived = 0 AND c.kind = ?`,
    [userId, userId, kind],
  );
  for (const r of rows || []) {
    const id = Number(r.id);
    if (excludeId != null && id === Number(excludeId)) continue;
    if (normalizeCategoryNameKey(r.name) === want) return id;
  }
  return null;
}

/**
 * CSV 取込用: 支出カテゴリを名前で検索し、無ければ作成する。
 * idByNormKey: 同一リクエスト内の正規化名 → id キャッシュ（省略可）
 * @returns {{ categoryId: number | null, created: boolean }}
 */
async function findOrCreateExpenseCategoryByName(
  pool,
  userId,
  familyId,
  catWhere,
  rawName,
  idByNormKey = null,
) {
  const name = String(rawName ?? "").trim();
  if (!name) return { categoryId: null, created: false };
  const safeName = name.length <= 100 ? name : name.slice(0, 100);
  const normKey = normalizeCategoryNameKey(safeName);
  if (idByNormKey?.has(normKey)) {
    return { categoryId: idByNormKey.get(normKey), created: false };
  }
  const dup = await findDuplicateCategoryId(
    pool,
    userId,
    catWhere,
    "expense",
    safeName,
    null,
  );
  if (dup != null) {
    idByNormKey?.set(normKey, dup);
    return { categoryId: dup, created: false };
  }
  const paramsBase = [userId, userId];
  const [[mx]] = await pool.query(
    `SELECT COALESCE(MAX(c.sort_order), 0) AS m FROM categories c
     WHERE ${catWhere} AND c.is_archived = 0 AND c.kind = 'expense'`,
    paramsBase,
  );
  const sortOrder = Number(mx?.m ?? 0) + 10;
  const [ins] = await pool.query(
    `INSERT INTO categories (user_id, family_id, parent_id, name, kind, color_hex, sort_order)
     VALUES (?, ?, NULL, ?, 'expense', NULL, ?)`,
    [userId, familyId, safeName, sortOrder],
  );
  const newId = Number(ins.insertId);
  idByNormKey?.set(normKey, newId);
  return { categoryId: newId, created: true };
}

function ymBounds(yearMonth) {
  const m = /^(\d{4})-(\d{2})$/.exec(yearMonth || "");
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const from = `${y}-${String(mo).padStart(2, "0")}-01`;
  const last = new Date(y, mo, 0).getDate();
  const to = `${y}-${String(mo).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
  return { from, to };
}

/** YYYY-MM の比較用インデックス（null: 不正） */
function ymToIndex(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ""));
  if (!m) return null;
  return Number(m[1]) * 12 + Number(m[2]) - 1;
}

/** 月初〜 inclusive のカレンダー月数（fromYm > toYm のときは 0） */
function inclusiveMonthSpan(fromYm, toYm) {
  const a = ymToIndex(fromYm);
  const b = ymToIndex(toYm);
  if (a == null || b == null || a > b) return 0;
  return b - a + 1;
}

async function familyFixedCostMonthlySum(pool, familyId) {
  if (!familyId) return 0;
  const [[row]] = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS s FROM family_fixed_cost_items WHERE family_id = ?`,
    [familyId],
  );
  return Math.round(Number(row?.s ?? 0));
}

async function ensureAdmin(pool, userId) {
  const [rows] = await pool.query(
    `SELECT id, email, is_admin FROM users WHERE id = ? LIMIT 1`,
    [userId],
  );
  const user = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  if (!user) return { ok: false, status: 401, body: { error: "認証ユーザーが見つかりません" } };
  const email = String(user.email || "").toLowerCase();
  const superAdmin = email === "script_00123@yahoo.co.jp";
  if (Number(user.is_admin) !== 1 && !superAdmin) {
    return { ok: false, status: 403, body: { error: "管理者権限が必要です" } };
  }
  return { ok: true };
}

const SUPPORT_CHAT_BODY_MAX = 8000;

function supportChatMigrationNeededResponseBody() {
  return {
    error: "SupportChatNotConfigured",
    detail:
      "db/migration_v14_chat_messages.sql、db/migration_v19_chat_messages_chat_scope.sql、db/migration_v22_chat_read_and_edit.sql を RDS に適用してください。",
  };
}

function isSupportChatTableMissingError(e) {
  const code = e && typeof e === "object" ? String(e.code || "") : "";
  if (code !== "ER_NO_SUCH_TABLE") return false;
  const msg =
    e && typeof e === "object" ? String(e.sqlMessage || "").toLowerCase() : "";
  return msg.includes("chat_messages");
}

function isChatScopeColumnMissingError(e) {
  if (!isErBadFieldErrorAppCore(e)) return false;
  const msg =
    e && typeof e === "object" ? String(e.sqlMessage || "").toLowerCase() : "";
  return msg.includes("chat_scope");
}

function isSupportChatReadStateTableMissingError(e) {
  const code = e && typeof e === "object" ? String(e.code || "") : "";
  if (code !== "ER_NO_SUCH_TABLE") return false;
  const msg =
    e && typeof e === "object" ? String(e.sqlMessage || "").toLowerCase() : "";
  return msg.includes("chat_room_read_state");
}

function isChatEditedAtColumnMissingError(e) {
  if (!isErBadFieldErrorAppCore(e)) return false;
  const msg =
    e && typeof e === "object" ? String(e.sqlMessage || "").toLowerCase() : "";
  return msg.includes("edited_at");
}

function isSupportChatDbConfigError(e) {
  return (
    isSupportChatTableMissingError(e) ||
    isChatScopeColumnMissingError(e) ||
    isSupportChatReadStateTableMissingError(e) ||
    isChatEditedAtColumnMissingError(e)
  );
}

async function fetchChatReadStates(pool, familyId, chatScope) {
  try {
    const [rows] = await pool.query(
      `SELECT user_id, last_read_message_id FROM chat_room_read_state WHERE family_id = ? AND chat_scope = ?`,
      [familyId, chatScope],
    );
    return (rows || []).map((r) => ({
      user_id: Number(r.user_id),
      last_read_message_id: Number(r.last_read_message_id ?? 0),
    }));
  } catch (e) {
    if (isSupportChatReadStateTableMissingError(e)) return [];
    throw e;
  }
}

async function upsertChatRoomReadState(pool, familyId, userId, chatScope, lastReadMessageId) {
  const lr = Number(lastReadMessageId);
  if (!Number.isFinite(lr) || lr < 0) return;
  await pool.query(
    `INSERT INTO chat_room_read_state (family_id, user_id, chat_scope, last_read_message_id)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       last_read_message_id = GREATEST(last_read_message_id, ?),
       updated_at = CURRENT_TIMESTAMP`,
    [familyId, userId, chatScope, lr, lr],
  );
}

async function userBelongsToFamily(pool, userId, familyId) {
  const [[row]] = await pool.query(
    `SELECT 1 AS ok FROM family_members WHERE family_id = ? AND user_id = ? LIMIT 1`,
    [familyId, userId],
  );
  return Boolean(row?.ok);
}

function normalizeSupportChatBody(raw) {
  const s = raw == null ? "" : String(raw);
  if (s.length > SUPPORT_CHAT_BODY_MAX) {
    return {
      error: `本文は${SUPPORT_CHAT_BODY_MAX}文字以内で入力してください`,
    };
  }
  const trimmed = s.trim();
  if (trimmed.length < 1) {
    return { error: "本文を入力してください" };
  }
  return { body: trimmed };
}

function clampSupportChatLimit(n, fallback = 50) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.min(200, Math.max(1, Math.floor(x)));
}

function rowToChatMessageApi(r) {
  if (!r) return null;
  const created = r.created_at;
  const createdAt =
    created instanceof Date ? created.toISOString() : r.created_at ?? null;
  const edited = r.edited_at;
  const editedAt =
    edited == null || edited === ""
      ? null
      : edited instanceof Date
        ? edited.toISOString()
        : String(r.edited_at);
  return {
    id: Number(r.id),
    family_id: Number(r.family_id),
    sender_user_id: Number(r.sender_user_id),
    body: String(r.body ?? ""),
    is_staff: Number(r.is_staff) === 1,
    is_important: Number(r.is_important) === 1,
    created_at: createdAt,
    edited_at: editedAt,
  };
}

/** ヘッダーお知らせ（未マイグレーション時は空） */
async function getHeaderAnnouncement(pool) {
  try {
    const [[row]] = await pool.query(
      `SELECT header_announcement FROM site_settings WHERE id = 1 LIMIT 1`,
    );
    if (!row) return "";
    return String(row.header_announcement ?? "").trim();
  } catch (e) {
    const code = e && typeof e === "object" ? e.code : "";
    if (code === "ER_NO_SUCH_TABLE") return "";
    throw e;
  }
}

/** 管理画面: モニター募集設定（未マイグレーション時は既定値） */
async function getMonitorRecruitmentSettings(pool) {
  try {
    const [[row]] = await pool.query(
      `SELECT monitor_recruitment_enabled, monitor_recruitment_text
       FROM site_settings WHERE id = 1 LIMIT 1`,
    );
    if (!row) {
      return { enabled: false, text: "" };
    }
    return {
      enabled:
        row.monitor_recruitment_enabled === true ||
        Number(row.monitor_recruitment_enabled) === 1,
      text: String(row.monitor_recruitment_text ?? "").trim(),
    };
  } catch (e) {
    const code = e && typeof e === "object" ? e.code : "";
    if (code === "ER_NO_SUCH_TABLE" || code === "ER_BAD_FIELD_ERROR") {
      return { enabled: false, text: "", migrationMissing: true };
    }
    throw e;
  }
}

/**
 * モニター募集設定の保存（INSERT … ON DUPLICATE KEY UPDATE）。主キー id=1、header は触らない。
 * @param {import("mysql2/promise").Pool} pool
 * @param {{ enabled: boolean, normalizedText: string }} param1
 * @returns {Promise<{ mode: "upsert" }>}
 */
async function saveMonitorRecruitmentSettings(pool, { enabled, normalizedText }) {
  await pool.query(
    `INSERT INTO site_settings
       (id, header_announcement, monitor_recruitment_enabled, monitor_recruitment_text)
     VALUES (1, '', ?, ?)
     ON DUPLICATE KEY UPDATE
       monitor_recruitment_enabled = VALUES(monitor_recruitment_enabled),
       monitor_recruitment_text = VALUES(monitor_recruitment_text),
       updated_at = NOW()`,
    [enabled ? 1 : 0, normalizedText],
  );
  return { mode: "upsert" };
}

/**
 * フロントの boolean / 1 / "true" 等を有効化フラグに解釈する
 * @param {unknown} v
 * @returns {boolean}
 */
function parseMonitorRecruitmentEnabled(v) {
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "on" || s === "yes";
}

function generateAdminTempPassword() {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < 12; i += 1) {
    out += chars[crypto.randomInt(chars.length)];
  }
  return out;
}

/**
 * @param {{ method: string, path: string, queryStringParameters?: Record<string,string>|null, body?: string|null, headers?: Record<string, string> }} req
 * @param {{ skipCors?: boolean }} [options]
 */
export async function handleApiRequest(req, options = {}) {
  const { skipCors = false } = options;
  const method = req.method.toUpperCase();
  const path = stripApiPathPrefix(req.path.split("?")[0] || "/");
  const hdrs = req.headers;

  if (method === "OPTIONS") {
    const cors = skipCors ? {} : buildCorsHeaders(hdrs);
    return { statusCode: 204, headers: { ...cors }, body: "" };
  }

  try {
    const authRes = await tryAuthRoutes(req, {
      json,
      hdrs,
      skipCors,
    });
    if (authRes) return authRes;

    if (routeKey(method, path) === "GET /") {
      return json(
        200,
        {
          service: "kakeibo-api",
          message:
            "API は稼働中です。認証: POST /auth/login（JWT）。ヘルス: GET /health",
          endpoints: {
            health: "/health",
            auth: "/auth/login",
            transactions: "/transactions",
            summary: "/summary/month",
            fixedCosts: "/settings/fixed-costs",
            stripeWebhook: "/webhooks/stripe",
            stripeWebhookApiPrefixed: "/api/webhooks/stripe",
            billingCheckoutSession: "/billing/checkout-session",
            billingSubscriptionStatus: "/billing/subscription-status",
            billingStripeStatus: "/billing/stripe-status",
            publicConfig: "/config",
            publicSettings: "/public/settings",
            userStats: "/user-stats",
            userStatsApiPrefix: "/api/user-stats",
            billingPortalSession: "/billing/portal-session",
            billingCancelSubscription: "/billing/cancel-subscription",
            announcement: "/announcement",
            adminAnnouncement: "/admin/announcement",
            adminMonitorRecruitmentSettings: "/admin/monitor-recruitment-settings",
            supportChatMessages: "/support/chat/messages",
            supportChatRead: "/support/chat/read",
            familyChatMessages: "/family/chat/messages",
            familyChatRead: "/family/chat/read",
            adminSupportChatRead: "/admin/support/chat/read",
            supportChatMessageById: "/support/chat/messages/{id}",
            familyChatMessageById: "/family/chat/messages/{id}",
            adminSupportChatFamilies: "/admin/support/chat/families",
            adminSupportChatMessages: "/admin/support/chat/messages",
            adminSubscriptionReconcile: "/admin/subscription-reconcile",
            adminSubscriptionReconcileApply: "/admin/subscription-reconcile/apply",
            checkPermission: "/check-permission?feature=…",
            checkPermissionApiPrefixed: "/api/check-permission?feature=…",
            featurePermissions: "/feature-permissions",
            adminFeaturePermissions: "/admin/feature-permissions",
            adminSalesMonthlySummary: "/admin/payments/monthly-summary",
            adminSalesDailySummary: "/admin/payments/daily-summary?from=…&to=…",
            adminSalesLogs: "/admin/payments/sales-logs",
            adminSalesCsv: "/admin/payments/export.csv",
            paypayImportPreview: "/import/paypay-csv/preview",
            paypayImportCommit: "/import/paypay-csv/commit",
          },
        },
        hdrs,
        skipCors,
      );
    }

    {
      const rk = routeKey(method, path);
      if (rk === "GET /config" || rk === "GET /api/config") {
        return json(
          200,
          { stripe: getStripeCheckoutPublicConfig() },
          hdrs,
          skipCors,
        );
      }
    }

    {
      const rk = routeKey(method, path);
      const healthGetOrHead = rk === "GET /health" || rk === "HEAD /health";
      if (healthGetOrHead) {
        const rdsHost = String(process.env.RDS_HOST || "").trim();
        if (!rdsHost) {
          if (method === "HEAD") {
            const cors = skipCors ? {} : buildCorsHeaders(hdrs);
            return { statusCode: 503, headers: { ...cors }, body: "" };
          }
          return json(
            503,
            {
              error: "DatabaseNotConfigured",
              detail:
                "データベース（RDS）に接続されていません。家計簿 API には MySQL の設定が必要です。",
            },
            hdrs,
            skipCors,
          );
        }
        try {
          await pingDatabase();
          if (method === "HEAD") {
            const cors = skipCors ? {} : buildCorsHeaders(hdrs);
            return { statusCode: 200, headers: { ...cors }, body: "" };
          }
          return json(200, { ok: true, database: "up" }, hdrs, skipCors);
        } catch (e) {
          logError("health.db", e, { method, path });
          const o = e && typeof e === "object" ? e : {};
          const code =
            o.code ?? (o.errno != null ? `errno_${o.errno}` : "UNKNOWN");
          const sqlMessage =
            typeof o.sqlMessage === "string" ? o.sqlMessage : undefined;
          const verbose =
            process.env.NODE_ENV === "development" ||
            process.env.HEALTH_VERBOSE === "true";
          if (method === "HEAD") {
            const cors = skipCors ? {} : buildCorsHeaders(hdrs);
            return { statusCode: 503, headers: { ...cors }, body: "" };
          }
          return json(
            503,
            {
              ok: false,
              error: "DatabaseUnavailable",
              code: String(code),
              ...(sqlMessage ? { sqlMessage } : {}),
              hint:
                "RDS の環境変数・VPC コネクタ・セキュリティグループを確認してください。",
              ...(verbose && e instanceof Error ? { message: e.message } : {}),
            },
            hdrs,
            skipCors,
          );
        }
      }
    }

    if (!isRdsConfigured()) {
      return json(
        503,
        {
          error: "DatabaseNotConfigured",
          detail:
            "データベース（RDS）に接続されていません。家計簿 API には MySQL の設定が必要です。",
        },
        hdrs,
        skipCors,
      );
    }

    const pool = getPool();

    {
      const rk = routeKey(method, path);
      if (rk === "POST /webhooks/stripe" || rk === "POST /api/webhooks/stripe") {
        const sigHeader =
          hdrs["stripe-signature"] ??
          hdrs["Stripe-Signature"] ??
          hdrs["STRIPE-SIGNATURE"];
        const rawPayload =
          req.stripeRawPayload != null
            ? req.stripeRawPayload
            : typeof req.body === "string"
              ? req.body
              : "";
        const wh = await processStripeWebhook(rawPayload, sigHeader, pool);
        return json(wh.statusCode, wh.body, hdrs, skipCors);
      }
      if (rk === "GET /billing/stripe-status") {
        return json(200, getStripeCheckoutPublicConfig(), hdrs, skipCors);
      }
      if (rk === "GET /announcement") {
        try {
          const text = await getHeaderAnnouncement(pool);
          return json(200, { text }, hdrs, skipCors);
        } catch (e) {
          logError("announcement.read", e, { method, path });
          return json(200, { text: "" }, hdrs, skipCors);
        }
      }
      /** 未認証可: モニター募集の表示用のみ（他の site 設定は含めない） */
      if (rk === "GET /public/settings") {
        try {
          const settings = await getMonitorRecruitmentSettings(pool);
          return json(
            200,
            {
              is_monitor_mode: settings.enabled === true,
              monitor_recruitment_text: String(settings.text ?? "").trim(),
            },
            hdrs,
            skipCors,
          );
        } catch (e) {
          logError("public.settings.read", e, { method, path });
          return json(
            200,
            { is_monitor_mode: false, monitor_recruitment_text: "" },
            hdrs,
            skipCors,
          );
        }
      }
      if (rk === "GET /user-stats" || rk === "GET /api/user-stats") {
        try {
          const body = await getPublicUserStatsPayload(pool);
          return json(200, body, hdrs, skipCors);
        } catch (e) {
          logError("user-stats.read", e, { method, path });
          return json(
            500,
            { error: "InternalError", detail: "統計の取得に失敗しました" },
            hdrs,
            skipCors,
          );
        }
      }
    }

    const userId = resolveUserId(hdrs);
    if (!userId) {
      return json(
        401,
        {
          error: "認証されていません",
          detail: "Authorization: Bearer <JWT> が必要です（開発時のみ ALLOW_X_USER_ID=true で X-User-Id 可）",
        },
        hdrs,
        skipCors,
      );
    }

    const q = req.queryStringParameters || {};
    await touchUserLastAccessedAt(pool, userId);
    const rkFeatEarly = routeKey(method, path);
    if (rkFeatEarly === "GET /check-permission" || rkFeatEarly === "GET /api/check-permission") {
      const feature = normalizeFeatureKey(q.feature ?? q.f);
      if (!feature) {
        return json(
          400,
          {
            error: "BadRequest",
            messageJa:
              "クエリ feature に機能キー（英小文字・数字・アンダースコア、例: receipt_ai）を指定してください。",
          },
          hdrs,
          skipCors,
        );
      }
      const subRow = await loadUserSubscriptionRowFull(pool, userId);
      const result = await evaluateFeatureForUser(pool, userId, feature, subRow);
      return json(200, result, hdrs, skipCors);
    }
    if (rkFeatEarly === "GET /feature-permissions" || rkFeatEarly === "GET /api/feature-permissions") {
      const subRow = await loadUserSubscriptionRowFull(pool, userId);
      const summary = await evaluateAllFeaturesForUser(pool, userId, subRow);
      return json(200, summary, hdrs, skipCors);
    }

    const familyId = await getDefaultFamilyId(pool, userId);

    const catWhere = `(c.family_id IN (SELECT family_id FROM family_members WHERE user_id = ?) OR (c.family_id IS NULL AND c.user_id = ?))`;
    const familyRoleUpper = await resolveUserFamilyRoleUpper(pool, userId);
    const kidWatchLedger = await resolveParentKidWatchLedger(
      pool,
      q,
      userId,
      familyRoleUpper,
      hdrs,
      skipCors,
    );
    if (kidWatchLedger.error) return kidWatchLedger.error;
    const isKidTxScope = familyRoleUpper === "KID";
    // ADMIN/MEMBER の家族取引のみ（同一 family_id の KID お小遣い帳は除外）。KID は従来どおり本人分のみ。
    const txCreatorIsAdultLedger =
      "EXISTS (SELECT 1 FROM users u_tx WHERE u_tx.id = t.user_id AND UPPER(TRIM(COALESCE(u_tx.family_role, 'MEMBER'))) IN ('ADMIN', 'MEMBER'))";
    const txCreatorIsKidLedger =
      "EXISTS (SELECT 1 FROM users u_tx WHERE u_tx.id = t.user_id AND UPPER(TRIM(COALESCE(u_tx.family_role, 'MEMBER'))) = 'KID')";
    let txWhereFamilyKidWatch = `(t.family_id IN (SELECT family_id FROM family_members WHERE user_id = ?) AND ${txCreatorIsKidLedger}`;
    const txP1KidWatch = [userId];
    if (kidWatchLedger.active && kidWatchLedger.kidUserId != null) {
      txWhereFamilyKidWatch += ` AND t.user_id = ?`;
      txP1KidWatch.push(kidWatchLedger.kidUserId);
    }
    txWhereFamilyKidWatch += `)`;
    const txWhere = isKidTxScope
      ? `(t.user_id = ? AND (t.family_id IN (SELECT family_id FROM family_members WHERE user_id = ?) OR (t.family_id IS NULL AND t.user_id = ?)))`
      : `((
          t.family_id IN (SELECT family_id FROM family_members WHERE user_id = ?)
          AND ${txCreatorIsAdultLedger}
        ) OR (t.family_id IS NULL AND t.user_id = ?))`;
    const txWhereFamily = isKidTxScope
      ? `(t.user_id = ? AND t.family_id IN (SELECT family_id FROM family_members WHERE user_id = ?))`
      : `(t.family_id IN (SELECT family_id FROM family_members WHERE user_id = ?) AND ${txCreatorIsAdultLedger})`;
    const txP2 = isKidTxScope ? [userId, userId, userId] : [userId, userId];
    const txP1 = isKidTxScope ? [userId, userId] : [userId];

    const normPath = path.replace(/\/$/, "") || "/";
    const txOneMatch = /^\/transactions\/(\d+)$/.exec(normPath);
    const categoryOneMatch = /^\/categories\/(\d+)$/.exec(normPath);
    const adminUserOneMatch = /^\/admin\/users\/(\d+)$/.exec(normPath);
    const adminUserResetPasswordMatch = /^\/admin\/users\/(\d+)\/reset-password$/.exec(normPath);
    const adminSupportChatMessageOneMatch =
      /^\/admin\/support\/chat\/messages\/(\d+)$/.exec(normPath);
    const supportChatMessageOneMatch = /^\/support\/chat\/messages\/(\d+)$/.exec(normPath);
    const familyChatMessageOneMatch = /^\/family\/chat\/messages\/(\d+)$/.exec(normPath);
    const receiptJobStatusMatch = /^\/receipts\/job-status\/([^/]+)$/.exec(normPath);

    if (receiptJobStatusMatch && method === "GET") {
      const jobId = String(receiptJobStatusMatch[1] || "").trim();
      if (!jobId) {
        return json(400, { error: "InvalidRequest", detail: "job_id が空です" }, hdrs, skipCors);
      }
      try {
        const [rows] = await pool.query(
          `SELECT job_id, user_id, status, result_data, error_message, created_at, updated_at
           FROM receipt_processing_jobs
           WHERE job_id = ? AND user_id = ?
           LIMIT 1`,
          [jobId, userId],
        );
        if (!Array.isArray(rows) || !rows[0]) {
          return json(404, { error: "NotFound", detail: "ジョブが見つかりません" }, hdrs, skipCors);
        }
        const j = rows[0];
        let result = null;
        if (j.result_data != null) {
          result =
            typeof j.result_data === "string" ? JSON.parse(j.result_data) : j.result_data;
        }
        return json(
          200,
          {
            jobId: String(j.job_id),
            status: j.status,
            result,
            errorMessage: j.error_message != null ? String(j.error_message) : null,
            createdAt: j.created_at,
            updatedAt: j.updated_at,
          },
          hdrs,
          skipCors,
        );
      } catch (e) {
        if (e && typeof e === "object" && e.code === "ER_NO_SUCH_TABLE") {
          return json(
            503,
            {
              error: "ReceiptJobUnavailable",
              detail:
                "receipt_processing_jobs がありません。db/migration_v43_receipt_processing_jobs.sql を実行してください。",
            },
            hdrs,
            skipCors,
          );
        }
        logError("receipts.job_status", e, { userId, jobId });
        return json(500, { error: "JobStatusError", detail: "ジョブの取得に失敗しました" }, hdrs, skipCors);
      }
    }

    if (txOneMatch && method === "PATCH") {
      const txId = Number(txOneMatch[1], 10);
      const b = JSON.parse(req.body || "{}");
      const txPatchSubRej = rejectNonAdminSubscriptionBodyFields(b, hdrs, skipCors);
      if (txPatchSubRej) return txPatchSubRej;
      const [[existing]] = await pool.query(
        `SELECT id, user_id, family_id, kind, amount, transaction_date, memo, category_id,
                is_medical_expense, medical_type, medical_patient_name
         FROM transactions t WHERE t.id = ? AND (${txWhere})`,
        [txId, ...txP2],
      );
      if (!existing) {
        return json(404, { error: "見つかりません" }, hdrs, skipCors);
      }
      const nextKind =
        b.kind === "income" || b.kind === "expense"
          ? b.kind
          : String(existing.kind || "expense");
      const amountProvided =
        Object.prototype.hasOwnProperty.call(b, "amount") &&
        b.amount !== null &&
        b.amount !== "";
      const nextAmount = amountProvided ? Number(b.amount) : Number(existing.amount);
      const nextDate =
        b.transaction_date != null && b.transaction_date !== ""
          ? String(b.transaction_date).slice(0, 10)
          : String(existing.transaction_date ?? "").slice(0, 10);
      const nextMemo = Object.prototype.hasOwnProperty.call(b, "memo")
        ? normalizeTxMemo(b.memo)
        : normalizeTxMemo(existing.memo);
      let nextCategoryId = existing.category_id;
      if (Object.prototype.hasOwnProperty.call(b, "category_id")) {
        if (b.category_id == null || b.category_id === "") {
          nextCategoryId = null;
        } else {
          const cid = Number(b.category_id);
          if (!Number.isFinite(cid)) {
            return json(400, { error: "category_id が不正です" }, hdrs, skipCors);
          }
          nextCategoryId = cid;
        }
      }
      const categoryTouched = Object.prototype.hasOwnProperty.call(b, "category_id");
      const medicalFieldSpecified = isMedicalFieldSpecified(b);
      let nextIsMedicalExpense = Number(existing.is_medical_expense) === 1;
      let nextMedicalType = normalizeMedicalType(existing.medical_type);
      let nextMedicalPatientName = normalizeMedicalPatientName(existing.medical_patient_name);
      if (categoryTouched && !medicalFieldSpecified) {
        const autoMedical = await resolveMedicalDefaultsFromCategory(
          pool,
          catWhere,
          userId,
          nextCategoryId,
        );
        nextIsMedicalExpense = autoMedical.isMedicalExpense;
        nextMedicalType = autoMedical.medicalType;
        nextMedicalPatientName = autoMedical.medicalPatientName;
      }
      if (Object.prototype.hasOwnProperty.call(b, "is_medical_expense")) {
        if (typeof b.is_medical_expense !== "boolean") {
          return json(400, { error: "is_medical_expense は boolean で指定してください" }, hdrs, skipCors);
        }
        nextIsMedicalExpense = b.is_medical_expense;
      }
      if (Object.prototype.hasOwnProperty.call(b, "medical_type")) {
        const mt = normalizeMedicalType(b.medical_type);
        if (b.medical_type != null && b.medical_type !== "" && mt == null) {
          return json(
            400,
            { error: "medical_type は treatment / medicine / other のいずれかです" },
            hdrs,
            skipCors,
          );
        }
        nextMedicalType = mt;
      }
      if (Object.prototype.hasOwnProperty.call(b, "medical_patient_name")) {
        nextMedicalPatientName = normalizeMedicalPatientName(b.medical_patient_name);
      }
      if (nextIsMedicalExpense && nextMedicalType == null) {
        return json(400, { error: "medical_type を選択してください" }, hdrs, skipCors);
      }
      if (!nextIsMedicalExpense) {
        nextMedicalType = null;
        nextMedicalPatientName = null;
      }
      const nextAmountValidation = validateTransactionAmount(nextKind, nextAmount);
      if (!nextAmountValidation.ok) {
        return json(400, { error: nextAmountValidation.error }, hdrs, skipCors);
      }
      const fields = [];
      const params = [];
      if (b.kind === "income" || b.kind === "expense") {
        fields.push("kind = ?");
        params.push(b.kind);
      }
      if (amountProvided) {
        fields.push("amount = ?");
        params.push(nextAmount);
      }
      if (b.transaction_date != null && b.transaction_date !== "") {
        fields.push("transaction_date = ?");
        params.push(nextDate);
      }
      if (Object.prototype.hasOwnProperty.call(b, "memo")) {
        fields.push("memo = ?");
        params.push(nextMemo);
      }
      if (Object.prototype.hasOwnProperty.call(b, "category_id")) {
        fields.push("category_id = ?");
        params.push(nextCategoryId);
      }
      if (medicalFieldSpecified || categoryTouched) {
        fields.push("is_medical_expense = ?");
        params.push(nextIsMedicalExpense ? 1 : 0);
        fields.push("medical_type = ?");
        params.push(nextMedicalType);
        fields.push("medical_patient_name = ?");
        params.push(nextMedicalPatientName);
      }
      if (fields.length === 0) {
        return json(400, { error: "更新項目がありません" }, hdrs, skipCors);
      }
      const categoryOrKindTouched =
        Object.prototype.hasOwnProperty.call(b, "category_id") ||
        b.kind === "income" ||
        b.kind === "expense";
      if (categoryOrKindTouched) {
        const catFixedRej = await rejectExpenseUsingLedgerFixedCategory(
          pool,
          catWhere,
          [userId, userId],
          nextKind,
          nextCategoryId,
        );
        if (catFixedRej) {
          return json(400, { error: catFixedRej }, hdrs, skipCors);
        }
      }
      const [dupRows] = await pool.query(
        `SELECT t.id, t.amount
         FROM transactions t
         WHERE t.user_id = ?
           AND t.id <> ?
           AND t.kind = ?
           AND t.transaction_date = ?
           AND (t.category_id <=> ?)
           AND (t.memo <=> ?)
           AND (t.is_medical_expense <=> ?)
           AND (t.medical_type <=> ?)
           AND (t.medical_patient_name <=> ?)
         ORDER BY t.id DESC
         LIMIT 1`,
        [
          userId,
          txId,
          nextKind,
          nextDate,
          nextCategoryId,
          nextMemo,
          nextIsMedicalExpense ? 1 : 0,
          nextMedicalType,
          nextMedicalPatientName,
        ],
      );
      const dup = Array.isArray(dupRows) && dupRows.length > 0 ? dupRows[0] : null;
      if (dup) {
        const mergedAmount = Number(dup.amount ?? 0) + Number(nextAmount ?? 0);
        const mergedValidation = validateTransactionAmount(nextKind, mergedAmount);
        if (!mergedValidation.ok) {
          return json(400, { error: mergedValidation.error }, hdrs, skipCors);
        }
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          await conn.query(
            `UPDATE transactions
             SET amount = ?, updated_at = NOW()
             WHERE id = ? AND user_id = ?`,
            [mergedAmount, dup.id, userId],
          );
          await conn.query(
            `DELETE FROM transactions
             WHERE id = ? AND user_id = ?`,
            [txId, userId],
          );
          await conn.commit();
        } catch (e) {
          await conn.rollback();
          throw e;
        } finally {
          conn.release();
        }
        return json(
          200,
          { ok: true, merged: true, mergedIntoId: Number(dup.id), deletedId: txId },
          hdrs,
          skipCors,
        );
      }
      params.push(txId);
      await pool.query(
        `UPDATE transactions t SET ${fields.join(", ")} WHERE t.id = ? AND (${txWhere})`,
        [...params, ...txP2],
      );
      return json(200, { ok: true }, hdrs, skipCors);
    }

    if (txOneMatch && method === "DELETE") {
      const txId = Number(txOneMatch[1], 10);
      const [delRes] = await pool.query(
        `DELETE t FROM transactions t WHERE t.id = ? AND (${txWhere})`,
        [txId, ...txP2],
      );
      if (!delRes.affectedRows) {
        return json(404, { error: "見つかりません" }, hdrs, skipCors);
      }
      return json(200, { ok: true }, hdrs, skipCors);
    }

    if (routeKey(method, path) === "GET /admin/users") {
      const admin = await ensureAdmin(pool, userId);
      if (!admin.ok) return json(admin.status, admin.body, hdrs, skipCors);
      const { rows, subscriptionStatusWritable } = await fetchAdminUsersListRows(pool);
      const items = rows.map((r) => ({
        id: Number(r.id),
        email: String(r.email ?? ""),
        login_name: r.login_name == null ? null : String(r.login_name),
        display_name: r.display_name == null ? null : String(r.display_name),
        isAdmin: Number(r.is_admin) === 1,
        subscriptionStatus:
          r.subscription_status != null && String(r.subscription_status).trim() !== ""
            ? String(r.subscription_status).trim()
            : "inactive",
        created_at: r.created_at ?? null,
        updated_at: r.updated_at ?? null,
        last_login_at: r.last_login_at ?? null,
        last_accessed_at: r.last_accessed_at ?? null,
        default_family_id: r.default_family_id ?? null,
        familyRole: String(r.family_role ?? "MEMBER")
          .trim()
          .toUpperCase(),
        kidTheme:
          r.kid_theme == null || String(r.kid_theme).trim() === ""
            ? null
            : normalizeAdminKidTheme(r.kid_theme) === "__invalid__"
              ? null
              : normalizeAdminKidTheme(r.kid_theme),
        family_peers: r.family_peers == null || r.family_peers === "" ? null : String(r.family_peers),
      }));
      return json(
        200,
        {
          items,
          meta: { subscriptionStatusWritable },
        },
        hdrs,
        skipCors,
      );
    }

    if (routeKey(method, path) === "GET /admin/feature-permissions") {
      const admin = await ensureAdmin(pool, userId);
      if (!admin.ok) return json(admin.status, admin.body, hdrs, skipCors);
      const rows = await fetchAllFeaturePermissions(pool);
      if (rows == null) {
        return json(
          503,
          {
            error: "MigrationRequired",
            messageJa:
              "feature_permissions テーブルがありません。backend で npm run db:migrate-v32 を実行してください。",
          },
          hdrs,
          skipCors,
        );
      }
      return json(200, { items: rows }, hdrs, skipCors);
    }

    if (routeKey(method, path) === "PATCH /admin/feature-permissions") {
      const admin = await ensureAdmin(pool, userId);
      if (!admin.ok) return json(admin.status, admin.body, hdrs, skipCors);
      let b = {};
      try {
        b = JSON.parse(req.body || "{}");
      } catch {
        return json(400, { error: "JSON が不正です" }, hdrs, skipCors);
      }
      const fk = normalizeFeatureKey(b.feature_key ?? b.featureKey);
      if (!fk) {
        return json(
          400,
          { error: "BadRequest", messageJa: "feature_key（英小文字ではじまるキー）が必要です。" },
          hdrs,
          skipCors,
        );
      }
      const mp = normalizeMinPlan(b.min_plan ?? b.minPlan);
      const rows = await fetchAllFeaturePermissions(pool);
      if (rows == null) {
        return json(
          503,
          {
            error: "MigrationRequired",
            messageJa:
              "feature_permissions テーブルがありません。backend で npm run db:migrate-v32 を実行してください。",
          },
          hdrs,
          skipCors,
        );
      }
      const ok = await setFeaturePermissionMinPlan(pool, fk, mp);
      if (!ok) {
        return json(
          404,
          {
            error: "UnknownFeature",
            messageJa:
              "この feature_key は登録されていません。マイグレ v32 のシードに含まれるキーのみ変更できます。",
          },
          hdrs,
          skipCors,
        );
      }
      return json(200, { ok: true, feature_key: fk, min_plan: mp }, hdrs, skipCors);
    }

    if (routeKey(method, path) === "GET /admin/subscription-reconcile") {
      const admin = await ensureAdmin(pool, userId);
      if (!admin.ok) return json(admin.status, admin.body, hdrs, skipCors);
      try {
        const stripe = new Stripe(requireStripeSecretKey());
        const result = await compareStripeSubscriptionsWithDb(stripe, pool);
        return json(200, result, hdrs, skipCors);
      } catch (e) {
        logError("admin.subscription_reconcile", e, { method, path });
        const raw = String(e?.message || e);
        const isPremiumCol =
          /Unknown column ['`]?u\.?is_premium|is_premium['`]?\s+in\s+['`]?field list/i.test(raw) ||
          raw.includes("ER_BAD_FIELD_ERROR");
        const messageJa = isPremiumCol
          ? "users テーブルに is_premium 列がありません。本番の RDS へ db/migration_v9_users_is_premium.sql（v9）を適用してください。適用後、照合は再実行で正常になります。"
          : `Stripe 照合に失敗しました: ${raw.length > 300 ? `${raw.slice(0, 300)}…` : raw}`;
        return json(
          500,
          {
            error: "SubscriptionReconcileFailed",
            detail: raw,
            messageJa,
          },
          hdrs,
          skipCors,
        );
      }
    }

    if (routeKey(method, path) === "POST /admin/subscription-reconcile/apply") {
      const admin = await ensureAdmin(pool, userId);
      if (!admin.ok) return json(admin.status, admin.body, hdrs, skipCors);
      const b = JSON.parse(req.body || "{}");
      const kind = String(b.kind ?? "")
        .trim()
        .toLowerCase();
      try {
        const stripe = new Stripe(requireStripeSecretKey());
        if (kind === "family") {
          const familyId = Number(b.familyId);
          if (!Number.isFinite(familyId) || familyId <= 0) {
            return json(
              400,
              {
                error: "InvalidRequest",
                messageJa: "正しい familyId（数値）を指定してください。",
              },
              hdrs,
              skipCors,
            );
          }
          const r = await applyOneFamilyMismatch(stripe, pool, familyId);
          if (!r.ok) {
            return json(
              400,
              { error: r.error, messageJa: r.messageJa },
              hdrs,
              skipCors,
            );
          }
          return json(200, { ok: true }, hdrs, skipCors);
        }
        if (kind === "user") {
          const uId = Number(b.userId);
          const fId = Number(b.familyId);
          if (!Number.isFinite(uId) || uId <= 0 || !Number.isFinite(fId) || fId <= 0) {
            return json(
              400,
              {
                error: "InvalidRequest",
                messageJa: "userId と familyId（ともに正の数）を指定してください。",
              },
              hdrs,
              skipCors,
            );
          }
          const r = await applyOneUserMismatch(stripe, pool, uId, fId);
          if (!r.ok) {
            return json(
              400,
              { error: r.error, messageJa: r.messageJa },
              hdrs,
              skipCors,
            );
          }
          return json(200, { ok: true }, hdrs, skipCors);
        }
        return json(
          400,
          {
            error: "InvalidRequest",
            messageJa: "kind には family（家族1件のDB修正）または user（プレミアム不整合1件の修正）を指定してください。",
          },
          hdrs,
          skipCors,
        );
      } catch (e) {
        logError("admin.subscription_reconcile_apply", e, { method, path, kind });
        const raw = String(e?.message || e);
        return json(
          500,
          {
            error: "SubscriptionReconcileApplyFailed",
            detail: raw,
            messageJa: `修正の適用に失敗しました: ${raw.length > 200 ? `${raw.slice(0, 200)}…` : raw}`,
          },
          hdrs,
          skipCors,
        );
      }
    }

    if (routeKey(method, path) === "POST /admin/users") {
      const admin = await ensureAdmin(pool, userId);
      if (!admin.ok) return json(admin.status, admin.body, hdrs, skipCors);
      const b = JSON.parse(req.body || "{}");
      const email = String(b.email ?? "").trim().toLowerCase();
      const loginRaw = b.login_name != null ? String(b.login_name).trim() : "";
      const loginName = loginRaw.length > 0 ? loginRaw : null;
      const password = String(b.password ?? "");
      const displayRaw = b.display_name != null ? String(b.display_name).trim() : "";
      const displayName = displayRaw.length > 0 ? displayRaw : null;
      const isAdmin = b.isAdmin === true;

      if (!email || !email.includes("@")) {
        return json(400, { error: "メールアドレスが不正です" }, hdrs, skipCors);
      }
      if (!validatePassword(password)) {
        return json(
          400,
          {
            error:
              "パスワードは英数字記号8文字以上としてください。英字・数字・記号をそれぞれ1文字以上含めてください",
          },
          hdrs,
          skipCors,
        );
      }
      if (loginName && !/^[a-zA-Z0-9]{1,15}$/.test(loginName)) {
        return json(400, { error: "ログインIDは英数字のみ・最大15文字で入力してください" }, hdrs, skipCors);
      }
      if (displayName && (!/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z0-9]+$/u.test(displayName) || displayName.length > 10)) {
        return json(400, { error: "表示名は漢字・カナ・英数字のみ、最大10文字で入力してください" }, hdrs, skipCors);
      }

      const passwordHash = await hashPassword(password);
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        // メール重複: 一般登録（/auth/register）は従来どおり 409。管理者追加のみ同じアドレスで複数ユーザーを作れる（v31 で email の UNIQUE 解除要）。
        if (loginName) {
          const loginLc = loginName.toLowerCase();
          const [loginDup] = await conn.query(
            `SELECT id FROM users WHERE LOWER(email) = ? OR (login_name IS NOT NULL AND LOWER(login_name) = ?) LIMIT 1`,
            [loginLc, loginLc],
          );
          if (loginDup.length > 0) {
            await conn.rollback();
            return json(409, { error: "このログインIDは既に使用されています（他の方のメールアドレスと同じ文字列も使えません）。別のログインIDを入力してください。" }, hdrs, skipCors);
          }
        }
        if (displayName) {
          const [dispDup] = await conn.query(
            `SELECT id FROM users WHERE display_name IS NOT NULL AND TRIM(display_name) <> '' AND LOWER(TRIM(display_name)) = LOWER(?) LIMIT 1`,
            [displayName],
          );
          if (dispDup.length > 0) {
            await conn.rollback();
            return json(409, { error: "この表示名は既に使われています。別の表示名を入力してください。" }, hdrs, skipCors);
          }
        }

        const [ur] = await conn.query(
          `INSERT INTO users (email, login_name, password_hash, display_name, is_admin)
           VALUES (?, ?, ?, ?, ?)`,
          [email, loginName, passwordHash, displayName, isAdmin ? 1 : 0],
        );
        const newUserId = Number(ur.insertId);
        const [fr] = await conn.query(`INSERT INTO families (name) VALUES (?)`, ["夫婦"]);
        const familyId = Number(fr.insertId);
        await conn.query(`UPDATE users SET default_family_id = ? WHERE id = ?`, [familyId, newUserId]);
        await conn.query(
          `INSERT INTO family_members (family_id, user_id, role) VALUES (?, ?, ?)`,
          [familyId, newUserId, "owner"],
        );
        await conn.commit();

        await seedDefaultCategoriesIfEmpty(pool, newUserId, familyId);
        return json(201, { ok: true, id: newUserId }, hdrs, skipCors);
      } catch (e) {
        await conn.rollback();
        const errno = Number(e?.errno);
        const isDup = e && typeof e === "object" && (e.code === "ER_DUP_ENTRY" || errno === 1062);
        if (isDup) {
          const m = String(e?.sqlMessage || e?.message || "");
          if (/uq_users_email|for key.*email|Duplicate.*email/i.test(m) || m.includes("users.")) {
            return json(
              409,
              {
                error:
                  "DB に users.email の一意制約が残っているため、同じメールでは追加できません。RDS に db/migration_v31_drop_users_email_unique.sql を適用するか、npm run db:migrate-v31 を実行してください。",
                code: "EmailUniqueConstraint",
              },
              hdrs,
              skipCors,
            );
          }
        }
        throw e;
      } finally {
        conn.release();
      }
    }

    if (adminUserOneMatch && method === "PATCH") {
      const admin = await ensureAdmin(pool, userId);
      if (!admin.ok) return json(admin.status, admin.body, hdrs, skipCors);
      const targetUserId = Number(adminUserOneMatch[1], 10);
      if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
        return json(400, { error: "ユーザーIDが不正です" }, hdrs, skipCors);
      }
      const [[existsTarget]] = await pool.query(`SELECT id FROM users WHERE id = ? LIMIT 1`, [
        targetUserId,
      ]);
      if (!existsTarget) {
        return json(404, { error: "対象ユーザーが見つかりません" }, hdrs, skipCors);
      }
      const b = JSON.parse(req.body || "{}");
      const updates = [];
      const params = [];
      let appliedFamilySub = false;
      let appliedFamilyRelink = false;

      if (Object.prototype.hasOwnProperty.call(b, "email")) {
        const nextEmail = String(b.email ?? "")
          .trim()
          .toLowerCase();
        if (!nextEmail || !nextEmail.includes("@") || /\s/.test(nextEmail)) {
          return json(400, { error: "メールアドレスが不正です" }, hdrs, skipCors);
        }
        if (nextEmail.length > 255) {
          return json(400, { error: "メールアドレスは255文字以内で入力してください" }, hdrs, skipCors);
        }
        updates.push("email = ?");
        params.push(nextEmail);
      }

      if (Object.prototype.hasOwnProperty.call(b, "isAdmin")) {
        if (typeof b.isAdmin !== "boolean") {
          return json(400, { error: "isAdmin は boolean で指定してください" }, hdrs, skipCors);
        }
        updates.push("is_admin = ?");
        params.push(b.isAdmin ? 1 : 0);
      }
      if (Object.prototype.hasOwnProperty.call(b, "displayName")) {
        const rawName = b.displayName == null ? "" : String(b.displayName).trim();
        if (rawName.length > 100) {
          return json(400, { error: "displayName は100文字以内で指定してください" }, hdrs, skipCors);
        }
        const normalized = rawName === "" ? null : rawName;
        if (normalized != null) {
          const [dupRows] = await pool.query(
            `SELECT id FROM users WHERE display_name IS NOT NULL AND TRIM(display_name) <> '' AND LOWER(TRIM(display_name)) = LOWER(?) AND id <> ? LIMIT 1`,
            [normalized, targetUserId],
          );
          if (dupRows.length > 0) {
            return json(
              409,
              {
                error:
                  "この表示名は既に使われています。別の表示名を入力してください。",
              },
              hdrs,
              skipCors,
            );
          }
        }
        updates.push("display_name = ?");
        params.push(normalized);
      }
      if (Object.prototype.hasOwnProperty.call(b, "subscriptionStatus")) {
        const normalizedSub = normalizeAdminSettableSubscriptionStatus(b.subscriptionStatus);
        if (normalizedSub == null) {
          return json(
            400,
            {
              error:
                "subscriptionStatus は inactive / active / past_due / canceled / trialing / unpaid / paused / admin_free（または別名 admin_granted）のいずれかで指定してください",
            },
            hdrs,
            skipCors,
          );
        }
        const targetFamilyId = await getDefaultFamilyId(pool, targetUserId);
        if (targetFamilyId) {
          try {
            const [famUpd] = await pool.query(
              `UPDATE families SET subscription_status = ?, updated_at = NOW() WHERE id = ?`,
              [normalizedSub, targetFamilyId],
            );
            appliedFamilySub = Boolean(famUpd?.affectedRows);
          } catch (e) {
            if (!isErBadFieldErrorAppCore(e)) throw e;
          }
        }
        if (!appliedFamilySub) {
          updates.push("subscription_status = ?");
          params.push(normalizedSub);
        }
      }
      if (
        Object.prototype.hasOwnProperty.call(b, "defaultFamilyId") ||
        Object.prototype.hasOwnProperty.call(b, "default_family_id")
      ) {
        const rawFam = b.defaultFamilyId ?? b.default_family_id;
        let newFam = null;
        if (rawFam !== null && rawFam !== undefined && String(rawFam).trim() !== "") {
          newFam = Number(rawFam);
          if (!Number.isFinite(newFam) || newFam <= 0) {
            return json(400, { error: "defaultFamilyId が不正です" }, hdrs, skipCors);
          }
          const [[frow]] = await pool.query(`SELECT id FROM families WHERE id = ? LIMIT 1`, [newFam]);
          if (!frow) {
            return json(400, { error: "指定の家族（defaultFamilyId）が見つかりません" }, hdrs, skipCors);
          }
        }
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          await conn.query(`DELETE FROM family_members WHERE user_id = ?`, [targetUserId]);
          if (newFam != null) {
            await conn.query(
              `INSERT INTO family_members (family_id, user_id, role) VALUES (?, ?, 'member')`,
              [newFam, targetUserId],
            );
            await conn.query(`UPDATE users SET default_family_id = ? WHERE id = ?`, [newFam, targetUserId]);
          } else {
            await conn.query(`UPDATE users SET default_family_id = NULL WHERE id = ?`, [targetUserId]);
          }
          await conn.commit();
          appliedFamilyRelink = true;
        } catch (e) {
          await conn.rollback();
          throw e;
        } finally {
          conn.release();
        }
      }
      if (Object.prototype.hasOwnProperty.call(b, "familyRole") || Object.prototype.hasOwnProperty.call(b, "family_role")) {
        const nr = normalizeAdminFamilyRole(b.familyRole ?? b.family_role);
        if (nr == null) {
          return json(
            400,
            { error: "familyRole は ADMIN / MEMBER / KID のいずれかで指定してください" },
            hdrs,
            skipCors,
          );
        }
        updates.push("family_role = ?");
        params.push(nr);
      }
      if (Object.prototype.hasOwnProperty.call(b, "kidTheme") || Object.prototype.hasOwnProperty.call(b, "kid_theme")) {
        const kt = normalizeAdminKidTheme(b.kidTheme ?? b.kid_theme);
        if (kt === "__invalid__") {
          return json(
            400,
            {
              error:
                "kidTheme は pink / lavender / pastel_yellow / mint_green / floral / blue / navy / dino_green / space_black / sky_red、または null（未設定）で指定してください",
            },
            hdrs,
            skipCors,
          );
        }
        if (kt == null) {
          updates.push("kid_theme = NULL");
        } else {
          updates.push("kid_theme = ?");
          params.push(kt);
        }
      }
      if (updates.length === 0 && !appliedFamilySub && !appliedFamilyRelink) {
        return json(400, { error: "更新項目がありません" }, hdrs, skipCors);
      }
      const [[exists]] = await pool.query(
        `SELECT id, is_admin FROM users WHERE id = ?`,
        [targetUserId],
      );
      if (
        Object.prototype.hasOwnProperty.call(b, "isAdmin") &&
        b.isAdmin === false &&
        Number(exists.is_admin) === 1
      ) {
        const [[cntRow]] = await pool.query(
          `SELECT COUNT(*) AS c FROM users WHERE is_admin = 1`,
        );
        if (Number(cntRow?.c) <= 1) {
          return json(400, { error: "最後の管理者の権限は外せません" }, hdrs, skipCors);
        }
      }
      if (updates.length > 0) {
        try {
          await pool.query(
            `UPDATE users SET ${updates.join(", ")}, updated_at = NOW() WHERE id = ?`,
            [...params, targetUserId],
          );
        } catch (e) {
          if (isUnknownSubscriptionColumnError(e)) {
            return json(
              503,
              {
                error: "SubscriptionColumnMissing",
                detail:
                  "users.subscription_status 列がありません。RDS に db/migration_v8_users_subscription_status.sql を適用してから、サブスク状態を変更してください。",
              },
              hdrs,
              skipCors,
            );
          }
          if (isErBadFieldErrorAppCore(e) && String(e?.message || "").includes("family_role")) {
            return json(
              503,
              {
                error: "FamilyRoleColumnMissing",
                detail:
                  "users.family_role 列がありません。RDS に db/migration_v18_users_family_role.sql を適用してください。",
              },
              hdrs,
              skipCors,
            );
          }
          if (isErBadFieldErrorAppCore(e) && String(e?.message || "").includes("kid_theme")) {
            return json(
              503,
              {
                error: "KidThemeColumnMissing",
                detail:
                  "users.kid_theme 列がありません。RDS に db/migration_v20_users_kid_theme.sql を適用してください。",
              },
              hdrs,
              skipCors,
            );
          }
          throw e;
        }
      }
      return json(200, { ok: true }, hdrs, skipCors);
    }

    if (adminUserResetPasswordMatch && method === "POST") {
      const admin = await ensureAdmin(pool, userId);
      if (!admin.ok) return json(admin.status, admin.body, hdrs, skipCors);
      const targetUserId = Number(adminUserResetPasswordMatch[1], 10);
      if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
        return json(400, { error: "ユーザーIDが不正です" }, hdrs, skipCors);
      }
      const tempPassword = generateAdminTempPassword();
      const passwordHash = await hashPassword(tempPassword);
      const [upd] = await pool.query(
        `UPDATE users SET password_hash = ?, updated_at = NOW() WHERE id = ?`,
        [passwordHash, targetUserId],
      );
      if (!upd?.affectedRows) {
        return json(404, { error: "対象ユーザーが見つかりません" }, hdrs, skipCors);
      }
      await pool.query(
        `DELETE FROM password_reset_tokens WHERE user_id = ?`,
        [targetUserId],
      );
      return json(
        200,
        {
          ok: true,
          temporaryPassword: tempPassword,
          message: "一時パスワードを発行しました。ログイン後に変更してください。",
        },
        hdrs,
        skipCors,
      );
    }

    if (adminUserOneMatch && method === "DELETE") {
      const admin = await ensureAdmin(pool, userId);
      if (!admin.ok) return json(admin.status, admin.body, hdrs, skipCors);
      const targetUserId = Number(adminUserOneMatch[1], 10);
      if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
        return json(400, { error: "ユーザーIDが不正です" }, hdrs, skipCors);
      }
      if (targetUserId === userId) {
        return json(400, { error: "自分自身は削除できません" }, hdrs, skipCors);
      }
      const [[target]] = await pool.query(
        `SELECT id, is_admin FROM users WHERE id = ?`,
        [targetUserId],
      );
      if (!target) {
        return json(404, { error: "対象ユーザーが見つかりません" }, hdrs, skipCors);
      }
      if (Number(target.is_admin) === 1) {
        const [[cntRow]] = await pool.query(
          `SELECT COUNT(*) AS c FROM users WHERE is_admin = 1`,
        );
        if (Number(cntRow?.c) <= 1) {
          return json(400, { error: "最後の管理者は削除できません" }, hdrs, skipCors);
        }
      }
      try {
        const { stripeResult } = await performUserAccountDeletion(pool, targetUserId);
        return json(200, { ok: true, stripe: stripeResult }, hdrs, skipCors);
      } catch (e) {
        if (e instanceof AccountDeletionDbError) {
          logError("admin.user.delete.db_failed_after_stripe", e.cause ?? e, {
            targetUserId,
            stripeResult: e.stripeResult,
          });
          return json(
            500,
            {
              error: "DeleteAccountDbFailed",
              detail:
                "データの削除中にエラーが発生しました。サブスクリプションは解約されている可能性があるため、サポートへお問い合わせください。",
              message: String(e?.message || e),
            },
            hdrs,
            skipCors,
          );
        }
        logError("admin.user.delete.stripe_cancel_failed", e, { targetUserId });
        return json(
          502,
          {
            error: "Stripe解約失敗",
            detail:
              "料金の解約処理に失敗したためユーザーを削除できませんでした。時間をおいて再試行するか、サポートにご連絡ください。",
            stripeMessage: String(e?.message || e),
          },
          hdrs,
          skipCors,
        );
      }
    }

    if (routeKey(method, path) === "GET /admin/announcement") {
      const admin = await ensureAdmin(pool, userId);
      if (!admin.ok) return json(admin.status, admin.body, hdrs, skipCors);
      try {
        const text = await getHeaderAnnouncement(pool);
        return json(200, { text }, hdrs, skipCors);
      } catch (e) {
        logError("admin.announcement.read", e, { method, path });
        return json(200, { text: "" }, hdrs, skipCors);
      }
    }

    if (routeKey(method, path) === "PUT /admin/announcement") {
      const admin = await ensureAdmin(pool, userId);
      if (!admin.ok) return json(admin.status, admin.body, hdrs, skipCors);
      let b = {};
      try {
        b = JSON.parse(req.body || "{}");
      } catch {
        return json(400, { error: "JSON が不正です" }, hdrs, skipCors);
      }
      const raw = b.text != null ? String(b.text) : "";
      const normalized = raw.replace(/\s+/g, " ").trim().slice(0, 512);
      try {
        await pool.query(
          `INSERT INTO site_settings (id, header_announcement) VALUES (1, ?)
           ON DUPLICATE KEY UPDATE header_announcement = VALUES(header_announcement)`,
          [normalized],
        );
      } catch (e) {
        const code = e && typeof e === "object" ? e.code : "";
        if (code === "ER_NO_SUCH_TABLE") {
          return json(
            503,
            {
              error: "お知らせ機能の DB 未適用",
              detail: "db/migration_v13_site_settings_header_announcement.sql を RDS に適用してください。",
            },
            hdrs,
            skipCors,
          );
        }
        throw e;
      }
      return json(200, { ok: true, text: normalized }, hdrs, skipCors);
    }

    if (routeKey(method, path) === "GET /admin/monitor-recruitment-settings") {
      const admin = await ensureAdmin(pool, userId);
      if (!admin.ok) return json(admin.status, admin.body, hdrs, skipCors);
      const settings = await getMonitorRecruitmentSettings(pool);
      return json(
        200,
        {
          enabled: settings.enabled === true,
          text: String(settings.text ?? ""),
          migrationMissing: settings.migrationMissing === true,
        },
        hdrs,
        skipCors,
      );
    }

    if (
      routeKey(method, path) === "PUT /admin/monitor-recruitment-settings" ||
      routeKey(method, path) === "POST /admin/monitor-recruitment-settings"
    ) {
      const admin = await ensureAdmin(pool, userId);
      if (!admin.ok) return json(admin.status, admin.body, hdrs, skipCors);
      let b = {};
      try {
        b = JSON.parse(req.body || "{}");
      } catch {
        return json(400, { error: "JSON が不正です" }, hdrs, skipCors);
      }
      const enabled = parseMonitorRecruitmentEnabled(b.enabled);
      const rawText = b.text != null ? String(b.text) : "";
      const normalizedText = rawText.replace(/\s+/g, " ").trim().slice(0, 512);
      let saveMode = "update";
      try {
        const result = await saveMonitorRecruitmentSettings(pool, {
          enabled,
          normalizedText,
        });
        saveMode = result.mode;
      } catch (e) {
        const code = e && typeof e === "object" ? e.code : "";
        if (code === "ER_NO_SUCH_TABLE" || code === "ER_BAD_FIELD_ERROR") {
          return json(
            503,
            {
              error: "モニター募集設定の DB 未適用",
              detail:
                "db/migration_v25_monitor_recruitment_settings.sql を RDS に適用してください。",
            },
            hdrs,
            skipCors,
          );
        }
        throw e;
      }
      logger.info("admin.monitor_recruitment.saved", {
        userId,
        method,
        mode: saveMode,
        enabled,
        textLength: normalizedText.length,
      });
      return json(200, { ok: true, enabled, text: normalizedText, saveMode }, hdrs, skipCors);
    }

    if (routeKey(method, path) === "GET /support/chat/messages") {
      let targetFamilyId = null;
      const rawFam = q.family_id ?? q.familyId;
      if (rawFam != null && String(rawFam).trim() !== "") {
        const fid = Number(rawFam, 10);
        if (!Number.isFinite(fid) || fid <= 0) {
          return json(400, { error: "family_id が不正です" }, hdrs, skipCors);
        }
        const member = await userBelongsToFamily(pool, userId, fid);
        if (!member) {
          return json(403, { error: "この家族のチャットを表示できません" }, hdrs, skipCors);
        }
        targetFamilyId = fid;
      } else {
        const def = await getDefaultFamilyId(pool, userId);
        if (!def) {
          return json(400, { error: "家族が未設定です" }, hdrs, skipCors);
        }
        targetFamilyId = def;
      }
      const limit = clampSupportChatLimit(q.limit, 50);
      const beforeRaw = q.before ?? q.before_id;
      const beforeId =
        beforeRaw != null && String(beforeRaw).trim() !== ""
          ? Number(beforeRaw, 10)
          : null;
      if (beforeId != null && (!Number.isFinite(beforeId) || beforeId <= 0)) {
        return json(400, { error: "before が不正です" }, hdrs, skipCors);
      }
      const fetchLimit = limit + 1;
      try {
        const [rows] =
          beforeId == null
            ? await pool.query(
                `SELECT id, family_id, sender_user_id, body, is_staff, is_important, created_at, edited_at
                 FROM chat_messages
                 WHERE family_id = ? AND chat_scope = 'support' AND deleted_at IS NULL
                 ORDER BY id DESC
                 LIMIT ?`,
                [targetFamilyId, fetchLimit],
              )
            : await pool.query(
                `SELECT id, family_id, sender_user_id, body, is_staff, is_important, created_at, edited_at
                 FROM chat_messages
                 WHERE family_id = ? AND chat_scope = 'support' AND deleted_at IS NULL AND id < ?
                 ORDER BY id DESC
                 LIMIT ?`,
                [targetFamilyId, beforeId, fetchLimit],
              );
        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const items = page.map(rowToChatMessageApi).reverse();
        const nextBeforeId =
          hasMore && items.length > 0 ? Number(items[0].id) : null;
        const read_states = await fetchChatReadStates(pool, targetFamilyId, "support");
        return json(
          200,
          {
            family_id: targetFamilyId,
            items,
            read_states,
            has_more: hasMore,
            next_before_id: nextBeforeId,
          },
          hdrs,
          skipCors,
        );
      } catch (e) {
        if (isSupportChatDbConfigError(e)) {
          return json(503, supportChatMigrationNeededResponseBody(), hdrs, skipCors);
        }
        throw e;
      }
    }

    if (routeKey(method, path) === "POST /support/chat/messages") {
      let b = {};
      try {
        b = JSON.parse(req.body || "{}");
      } catch {
        return json(400, { error: "JSON が不正です" }, hdrs, skipCors);
      }
      let targetFamilyId = null;
      const rawFam = b.family_id ?? b.familyId;
      if (rawFam != null && String(rawFam).trim() !== "") {
        const fid = Number(rawFam, 10);
        if (!Number.isFinite(fid) || fid <= 0) {
          return json(400, { error: "family_id が不正です" }, hdrs, skipCors);
        }
        const member = await userBelongsToFamily(pool, userId, fid);
        if (!member) {
          return json(403, { error: "この家族のチャットに投稿できません" }, hdrs, skipCors);
        }
        targetFamilyId = fid;
      } else {
        const def = await getDefaultFamilyId(pool, userId);
        if (!def) {
          return json(400, { error: "家族が未設定です" }, hdrs, skipCors);
        }
        targetFamilyId = def;
      }
      const normBody = normalizeSupportChatBody(b.body);
      if (normBody.error) {
        return json(400, { error: normBody.error }, hdrs, skipCors);
      }
      try {
        const [ins] = await pool.query(
          `INSERT INTO chat_messages (family_id, sender_user_id, body, is_staff, is_important, chat_scope)
           VALUES (?, ?, ?, 0, 0, 'support')`,
          [targetFamilyId, userId, normBody.body],
        );
        const newId = Number(ins.insertId);
        const [[row]] = await pool.query(
          `SELECT id, family_id, sender_user_id, body, is_staff, is_important, created_at, edited_at
           FROM chat_messages WHERE id = ? LIMIT 1`,
          [newId],
        );
        return json(201, { message: rowToChatMessageApi(row) }, hdrs, skipCors);
      } catch (e) {
        if (isSupportChatDbConfigError(e)) {
          return json(503, supportChatMigrationNeededResponseBody(), hdrs, skipCors);
        }
        throw e;
      }
    }

    if (routeKey(method, path) === "GET /family/chat/messages") {
      let targetFamilyId = null;
      const rawFam = q.family_id ?? q.familyId;
      if (rawFam != null && String(rawFam).trim() !== "") {
        const fid = Number(rawFam, 10);
        if (!Number.isFinite(fid) || fid <= 0) {
          return json(400, { error: "family_id が不正です" }, hdrs, skipCors);
        }
        const member = await canAccessFamilyChat(pool, userId, fid);
        if (!member) {
          return json(403, { error: "この家族のチャットを表示できません" }, hdrs, skipCors);
        }
        targetFamilyId = fid;
      } else {
        const def = await resolveFamilyIdWithChatFallback(pool, userId);
        if (!def) {
          return json(400, { error: "家族が未設定です" }, hdrs, skipCors);
        }
        targetFamilyId = def;
      }
      const limit = clampSupportChatLimit(q.limit, 50);
      const beforeRaw = q.before ?? q.before_id;
      const beforeId =
        beforeRaw != null && String(beforeRaw).trim() !== ""
          ? Number(beforeRaw, 10)
          : null;
      if (beforeId != null && (!Number.isFinite(beforeId) || beforeId <= 0)) {
        return json(400, { error: "before が不正です" }, hdrs, skipCors);
      }
      const fetchLimit = limit + 1;
      const roleUpper = await resolveUserFamilyRoleUpper(pool, userId);
      const kidFilter =
        roleUpper === "KID"
          ? `AND (
              m.sender_user_id = ?
              OR m.sender_user_id IN (
                SELECT u2.id FROM family_members fm2
                INNER JOIN users u2 ON u2.id = fm2.user_id
                WHERE fm2.family_id = ?
                  AND (
                    UPPER(TRIM(COALESCE(u2.family_role, 'MEMBER'))) IN ('ADMIN', 'MEMBER')
                    OR (
                      UPPER(TRIM(COALESCE(u2.family_role, 'MEMBER'))) = 'KID'
                      AND u2.id <> ?
                    )
                  )
              )
            )`
          : "";
      try {
        const [rows] =
          beforeId == null
            ? roleUpper === "KID"
              ? await pool.query(
                  `SELECT m.id, m.family_id, m.sender_user_id, m.body, m.is_staff, m.is_important, m.created_at, m.edited_at
                   FROM chat_messages m
                   WHERE m.family_id = ? AND m.chat_scope = 'family' AND m.deleted_at IS NULL
                   ${kidFilter}
                   ORDER BY m.id DESC
                   LIMIT ?`,
                  [targetFamilyId, userId, targetFamilyId, userId, fetchLimit],
                )
              : await pool.query(
                  `SELECT id, family_id, sender_user_id, body, is_staff, is_important, created_at, edited_at
                   FROM chat_messages
                   WHERE family_id = ? AND chat_scope = 'family' AND deleted_at IS NULL
                   ORDER BY id DESC
                   LIMIT ?`,
                  [targetFamilyId, fetchLimit],
                )
            : roleUpper === "KID"
              ? await pool.query(
                  `SELECT m.id, m.family_id, m.sender_user_id, m.body, m.is_staff, m.is_important, m.created_at, m.edited_at
                   FROM chat_messages m
                   WHERE m.family_id = ? AND m.chat_scope = 'family' AND m.deleted_at IS NULL
                   ${kidFilter}
                   AND m.id < ?
                   ORDER BY m.id DESC
                   LIMIT ?`,
                  [targetFamilyId, userId, targetFamilyId, userId, beforeId, fetchLimit],
                )
              : await pool.query(
                  `SELECT id, family_id, sender_user_id, body, is_staff, is_important, created_at, edited_at
                   FROM chat_messages
                   WHERE family_id = ? AND chat_scope = 'family' AND deleted_at IS NULL AND id < ?
                   ORDER BY id DESC
                   LIMIT ?`,
                  [targetFamilyId, beforeId, fetchLimit],
                );
        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const items = page.map(rowToChatMessageApi).reverse();
        const nextBeforeId =
          hasMore && items.length > 0 ? Number(items[0].id) : null;
        const read_states = await fetchChatReadStates(pool, targetFamilyId, "family");
        return json(
          200,
          {
            family_id: targetFamilyId,
            items,
            read_states,
            has_more: hasMore,
            next_before_id: nextBeforeId,
          },
          hdrs,
          skipCors,
        );
      } catch (e) {
        if (isSupportChatDbConfigError(e)) {
          return json(503, supportChatMigrationNeededResponseBody(), hdrs, skipCors);
        }
        throw e;
      }
    }

    if (routeKey(method, path) === "POST /family/chat/messages") {
      let b = {};
      try {
        b = JSON.parse(req.body || "{}");
      } catch {
        return json(400, { error: "JSON が不正です" }, hdrs, skipCors);
      }
      let targetFamilyId = null;
      const rawFam = b.family_id ?? b.familyId;
      if (rawFam != null && String(rawFam).trim() !== "") {
        const fid = Number(rawFam, 10);
        if (!Number.isFinite(fid) || fid <= 0) {
          return json(400, { error: "family_id が不正です" }, hdrs, skipCors);
        }
        const member = await canAccessFamilyChat(pool, userId, fid);
        if (!member) {
          return json(403, { error: "この家族のチャットに投稿できません" }, hdrs, skipCors);
        }
        targetFamilyId = fid;
      } else {
        const def = await resolveFamilyIdWithChatFallback(pool, userId);
        if (!def) {
          return json(400, { error: "家族が未設定です" }, hdrs, skipCors);
        }
        targetFamilyId = def;
      }
      const normBody = normalizeSupportChatBody(b.body);
      if (normBody.error) {
        return json(400, { error: normBody.error }, hdrs, skipCors);
      }
      try {
        const [ins] = await pool.query(
          `INSERT INTO chat_messages (family_id, sender_user_id, body, is_staff, is_important, chat_scope)
           VALUES (?, ?, ?, 0, 0, 'family')`,
          [targetFamilyId, userId, normBody.body],
        );
        const newId = Number(ins.insertId);
        const [[row]] = await pool.query(
          `SELECT id, family_id, sender_user_id, body, is_staff, is_important, created_at, edited_at
           FROM chat_messages WHERE id = ? LIMIT 1`,
          [newId],
        );
        return json(201, { message: rowToChatMessageApi(row) }, hdrs, skipCors);
      } catch (e) {
        if (isSupportChatDbConfigError(e)) {
          return json(503, supportChatMigrationNeededResponseBody(), hdrs, skipCors);
        }
        throw e;
      }
    }

    if (routeKey(method, path) === "POST /support/chat/read") {
      let b = {};
      try {
        b = JSON.parse(req.body || "{}");
      } catch {
        return json(400, { error: "JSON が不正です" }, hdrs, skipCors);
      }
      const lr = Number(b.last_read_message_id ?? b.lastReadMessageId);
      if (!Number.isFinite(lr) || lr < 0) {
        return json(400, { error: "last_read_message_id が必要です" }, hdrs, skipCors);
      }
      let targetFamilyId = null;
      const rawFam = b.family_id ?? b.familyId;
      if (rawFam != null && String(rawFam).trim() !== "") {
        const fid = Number(rawFam, 10);
        if (!Number.isFinite(fid) || fid <= 0) {
          return json(400, { error: "family_id が不正です" }, hdrs, skipCors);
        }
        const member = await userBelongsToFamily(pool, userId, fid);
        if (!member) {
          return json(403, { error: "この家族のチャットにアクセスできません" }, hdrs, skipCors);
        }
        targetFamilyId = fid;
      } else {
        const def = await getDefaultFamilyId(pool, userId);
        if (!def) {
          return json(400, { error: "家族が未設定です" }, hdrs, skipCors);
        }
        targetFamilyId = def;
      }
      try {
        const [[mx]] = await pool.query(
          `SELECT COALESCE(MAX(id), 0) AS mx FROM chat_messages WHERE family_id = ? AND chat_scope = 'support' AND deleted_at IS NULL`,
          [targetFamilyId],
        );
        const cap = Math.min(lr, Number(mx?.mx ?? 0));
        await upsertChatRoomReadState(pool, targetFamilyId, userId, "support", cap);
        return json(200, { ok: true, last_read_message_id: cap }, hdrs, skipCors);
      } catch (e) {
        if (isSupportChatDbConfigError(e)) {
          return json(503, supportChatMigrationNeededResponseBody(), hdrs, skipCors);
        }
        throw e;
      }
    }

    if (routeKey(method, path) === "POST /family/chat/read") {
      let b = {};
      try {
        b = JSON.parse(req.body || "{}");
      } catch {
        return json(400, { error: "JSON が不正です" }, hdrs, skipCors);
      }
      const lr = Number(b.last_read_message_id ?? b.lastReadMessageId);
      if (!Number.isFinite(lr) || lr < 0) {
        return json(400, { error: "last_read_message_id が必要です" }, hdrs, skipCors);
      }
      let targetFamilyId = null;
      const rawFam = b.family_id ?? b.familyId;
      if (rawFam != null && String(rawFam).trim() !== "") {
        const fid = Number(rawFam, 10);
        if (!Number.isFinite(fid) || fid <= 0) {
          return json(400, { error: "family_id が不正です" }, hdrs, skipCors);
        }
        const member = await canAccessFamilyChat(pool, userId, fid);
        if (!member) {
          return json(403, { error: "この家族のチャットにアクセスできません" }, hdrs, skipCors);
        }
        targetFamilyId = fid;
      } else {
        const def = await resolveFamilyIdWithChatFallback(pool, userId);
        if (!def) {
          return json(400, { error: "家族が未設定です" }, hdrs, skipCors);
        }
        targetFamilyId = def;
      }
      try {
        const [[mx]] = await pool.query(
          `SELECT COALESCE(MAX(id), 0) AS mx FROM chat_messages WHERE family_id = ? AND chat_scope = 'family' AND deleted_at IS NULL`,
          [targetFamilyId],
        );
        const cap = Math.min(lr, Number(mx?.mx ?? 0));
        await upsertChatRoomReadState(pool, targetFamilyId, userId, "family", cap);
        return json(200, { ok: true, last_read_message_id: cap }, hdrs, skipCors);
      } catch (e) {
        if (isSupportChatDbConfigError(e)) {
          return json(503, supportChatMigrationNeededResponseBody(), hdrs, skipCors);
        }
        throw e;
      }
    }

    if (routeKey(method, path) === "POST /admin/support/chat/read") {
      const admin = await ensureAdmin(pool, userId);
      if (!admin.ok) return json(admin.status, admin.body, hdrs, skipCors);
      let b = {};
      try {
        b = JSON.parse(req.body || "{}");
      } catch {
        return json(400, { error: "JSON が不正です" }, hdrs, skipCors);
      }
      const lr = Number(b.last_read_message_id ?? b.lastReadMessageId);
      if (!Number.isFinite(lr) || lr < 0) {
        return json(400, { error: "last_read_message_id が必要です" }, hdrs, skipCors);
      }
      const rawFam = b.family_id ?? b.familyId;
      const targetFamilyId = Number(rawFam, 10);
      if (!Number.isFinite(targetFamilyId) || targetFamilyId <= 0) {
        return json(400, { error: "family_id が必要です" }, hdrs, skipCors);
      }
      const [[fam]] = await pool.query(`SELECT id FROM families WHERE id = ? LIMIT 1`, [
        targetFamilyId,
      ]);
      if (!fam) {
        return json(404, { error: "家族が見つかりません" }, hdrs, skipCors);
      }
      if (!(await familyIsInAdminUserDirectory(pool, targetFamilyId))) {
        return json(
          404,
          {
            error: "FamilyNotInAdminList",
            messageJa:
              "この家族は管理画面のユーザー一覧にいない（どのユーザーの既定家族IDでもない）ため、サポートチャット管理の対象外です。",
          },
          hdrs,
          skipCors,
        );
      }
      try {
        const [[mx]] = await pool.query(
          `SELECT COALESCE(MAX(id), 0) AS mx FROM chat_messages WHERE family_id = ? AND chat_scope = 'support' AND deleted_at IS NULL`,
          [targetFamilyId],
        );
        const cap = Math.min(lr, Number(mx?.mx ?? 0));
        await upsertChatRoomReadState(pool, targetFamilyId, userId, "support", cap);
        return json(200, { ok: true, last_read_message_id: cap }, hdrs, skipCors);
      } catch (e) {
        if (isSupportChatDbConfigError(e)) {
          return json(503, supportChatMigrationNeededResponseBody(), hdrs, skipCors);
        }
        throw e;
      }
    }

    if (supportChatMessageOneMatch && method === "PATCH") {
      const msgId = Number(supportChatMessageOneMatch[1], 10);
      if (!Number.isFinite(msgId) || msgId <= 0) {
        return json(400, { error: "メッセージIDが不正です" }, hdrs, skipCors);
      }
      let b = {};
      try {
        b = JSON.parse(req.body || "{}");
      } catch {
        return json(400, { error: "JSON が不正です" }, hdrs, skipCors);
      }
      if (!Object.prototype.hasOwnProperty.call(b, "body")) {
        return json(400, { error: "body が必要です" }, hdrs, skipCors);
      }
      const norm = normalizeSupportChatBody(b.body);
      if (norm.error) {
        return json(400, { error: norm.error }, hdrs, skipCors);
      }
      try {
        const [[row]] = await pool.query(
          `SELECT id, family_id, sender_user_id, chat_scope, deleted_at, is_staff
           FROM chat_messages WHERE id = ? LIMIT 1`,
          [msgId],
        );
        if (!row || row.deleted_at != null) {
          return json(404, { error: "メッセージが見つかりません" }, hdrs, skipCors);
        }
        if (String(row.chat_scope) !== "support") {
          return json(404, { error: "メッセージが見つかりません" }, hdrs, skipCors);
        }
        if (Number(row.sender_user_id) !== Number(userId)) {
          return json(403, { error: "自分のメッセージのみ編集できます" }, hdrs, skipCors);
        }
        if (Number(row.is_staff) === 1) {
          return json(403, { error: "このメッセージは編集できません" }, hdrs, skipCors);
        }
        const fid = Number(row.family_id);
        const member = await userBelongsToFamily(pool, userId, fid);
        if (!member) {
          return json(403, { error: "この家族のチャットを編集できません" }, hdrs, skipCors);
        }
        const [upd] = await pool.query(
          `UPDATE chat_messages SET body = ?, edited_at = NOW() WHERE id = ? AND chat_scope = 'support' AND deleted_at IS NULL`,
          [norm.body, msgId],
        );
        if (!upd?.affectedRows) {
          return json(404, { error: "メッセージが見つかりません" }, hdrs, skipCors);
        }
        const [[out]] = await pool.query(
          `SELECT id, family_id, sender_user_id, body, is_staff, is_important, created_at, edited_at
           FROM chat_messages WHERE id = ? LIMIT 1`,
          [msgId],
        );
        return json(200, { message: rowToChatMessageApi(out) }, hdrs, skipCors);
      } catch (e) {
        if (isSupportChatDbConfigError(e)) {
          return json(503, supportChatMigrationNeededResponseBody(), hdrs, skipCors);
        }
        throw e;
      }
    }

    if (supportChatMessageOneMatch && method === "DELETE") {
      const msgId = Number(supportChatMessageOneMatch[1], 10);
      if (!Number.isFinite(msgId) || msgId <= 0) {
        return json(400, { error: "メッセージIDが不正です" }, hdrs, skipCors);
      }
      try {
        const [[row]] = await pool.query(
          `SELECT id, family_id, sender_user_id, chat_scope, deleted_at, is_staff
           FROM chat_messages WHERE id = ? LIMIT 1`,
          [msgId],
        );
        if (!row || row.deleted_at != null) {
          return json(404, { error: "メッセージが見つかりません" }, hdrs, skipCors);
        }
        if (String(row.chat_scope) !== "support") {
          return json(404, { error: "メッセージが見つかりません" }, hdrs, skipCors);
        }
        if (Number(row.sender_user_id) !== Number(userId)) {
          return json(403, { error: "自分のメッセージのみ削除できます" }, hdrs, skipCors);
        }
        if (Number(row.is_staff) === 1) {
          return json(403, { error: "このメッセージは削除できません" }, hdrs, skipCors);
        }
        const fid = Number(row.family_id);
        const member = await userBelongsToFamily(pool, userId, fid);
        if (!member) {
          return json(403, { error: "この家族のチャットを削除できません" }, hdrs, skipCors);
        }
        const [upd] = await pool.query(
          `UPDATE chat_messages SET deleted_at = NOW() WHERE id = ? AND chat_scope = 'support' AND deleted_at IS NULL`,
          [msgId],
        );
        if (!upd?.affectedRows) {
          return json(404, { error: "メッセージが見つかりません" }, hdrs, skipCors);
        }
        return json(200, { ok: true }, hdrs, skipCors);
      } catch (e) {
        if (isSupportChatDbConfigError(e)) {
          return json(503, supportChatMigrationNeededResponseBody(), hdrs, skipCors);
        }
        throw e;
      }
    }

    if (familyChatMessageOneMatch && method === "PATCH") {
      const msgId = Number(familyChatMessageOneMatch[1], 10);
      if (!Number.isFinite(msgId) || msgId <= 0) {
        return json(400, { error: "メッセージIDが不正です" }, hdrs, skipCors);
      }
      let b = {};
      try {
        b = JSON.parse(req.body || "{}");
      } catch {
        return json(400, { error: "JSON が不正です" }, hdrs, skipCors);
      }
      if (!Object.prototype.hasOwnProperty.call(b, "body")) {
        return json(400, { error: "body が必要です" }, hdrs, skipCors);
      }
      const norm = normalizeSupportChatBody(b.body);
      if (norm.error) {
        return json(400, { error: norm.error }, hdrs, skipCors);
      }
      try {
        const [[row]] = await pool.query(
          `SELECT id, family_id, sender_user_id, chat_scope, deleted_at
           FROM chat_messages WHERE id = ? LIMIT 1`,
          [msgId],
        );
        if (!row || row.deleted_at != null) {
          return json(404, { error: "メッセージが見つかりません" }, hdrs, skipCors);
        }
        if (String(row.chat_scope) !== "family") {
          return json(404, { error: "メッセージが見つかりません" }, hdrs, skipCors);
        }
        const fid = Number(row.family_id);
        const member = await canAccessFamilyChat(pool, userId, fid);
        if (!member) {
          return json(403, { error: "この家族のチャットを編集できません" }, hdrs, skipCors);
        }
        const mine = Number(row.sender_user_id) === Number(userId);
        if (!mine) {
          const owner = await isFamilyOwnerMember(pool, userId, fid);
          if (!owner) {
            return json(403, { error: "自分のメッセージのみ編集できます" }, hdrs, skipCors);
          }
        }
        const [upd] = await pool.query(
          `UPDATE chat_messages SET body = ?, edited_at = NOW() WHERE id = ? AND chat_scope = 'family' AND deleted_at IS NULL`,
          [norm.body, msgId],
        );
        if (!upd?.affectedRows) {
          return json(404, { error: "メッセージが見つかりません" }, hdrs, skipCors);
        }
        const [[out]] = await pool.query(
          `SELECT id, family_id, sender_user_id, body, is_staff, is_important, created_at, edited_at
           FROM chat_messages WHERE id = ? LIMIT 1`,
          [msgId],
        );
        return json(200, { message: rowToChatMessageApi(out) }, hdrs, skipCors);
      } catch (e) {
        if (isSupportChatDbConfigError(e)) {
          return json(503, supportChatMigrationNeededResponseBody(), hdrs, skipCors);
        }
        throw e;
      }
    }

    if (familyChatMessageOneMatch && method === "DELETE") {
      const msgId = Number(familyChatMessageOneMatch[1], 10);
      if (!Number.isFinite(msgId) || msgId <= 0) {
        return json(400, { error: "メッセージIDが不正です" }, hdrs, skipCors);
      }
      try {
        const [[row]] = await pool.query(
          `SELECT id, family_id, sender_user_id, chat_scope, deleted_at
           FROM chat_messages WHERE id = ? LIMIT 1`,
          [msgId],
        );
        if (!row || row.deleted_at != null) {
          return json(404, { error: "メッセージが見つかりません" }, hdrs, skipCors);
        }
        if (String(row.chat_scope) !== "family") {
          return json(404, { error: "メッセージが見つかりません" }, hdrs, skipCors);
        }
        const fid = Number(row.family_id);
        const member = await canAccessFamilyChat(pool, userId, fid);
        if (!member) {
          return json(403, { error: "この家族のチャットを削除できません" }, hdrs, skipCors);
        }
        const mine = Number(row.sender_user_id) === Number(userId);
        if (!mine) {
          const owner = await isFamilyOwnerMember(pool, userId, fid);
          if (!owner) {
            return json(403, { error: "自分のメッセージのみ削除できます" }, hdrs, skipCors);
          }
        }
        const [upd] = await pool.query(
          `UPDATE chat_messages SET deleted_at = NOW() WHERE id = ? AND chat_scope = 'family' AND deleted_at IS NULL`,
          [msgId],
        );
        if (!upd?.affectedRows) {
          return json(404, { error: "メッセージが見つかりません" }, hdrs, skipCors);
        }
        return json(200, { ok: true }, hdrs, skipCors);
      } catch (e) {
        if (isSupportChatDbConfigError(e)) {
          return json(503, supportChatMigrationNeededResponseBody(), hdrs, skipCors);
        }
        throw e;
      }
    }

    if (routeKey(method, path) === "GET /admin/support/chat/families") {
      const admin = await ensureAdmin(pool, userId);
      if (!admin.ok) return json(admin.status, admin.body, hdrs, skipCors);
      try {
        const [rows] = await pool.query(
          `SELECT f.id AS family_id,
                  f.name AS family_name,
                  lm.id AS last_message_id,
                  lm.body AS last_message_body,
                  lm.created_at AS last_message_at,
                  lm.sender_user_id AS last_sender_user_id,
                  lm.is_staff AS last_is_staff,
                  lm.is_important AS last_is_important,
                  rs.last_read_message_id AS admin_last_read_message_id
           FROM families f
           INNER JOIN (
             SELECT DISTINCT default_family_id AS id
             FROM users
             WHERE default_family_id IS NOT NULL
           ) admin_listed ON admin_listed.id = f.id
           LEFT JOIN (
             SELECT m.*
             FROM chat_messages m
             INNER JOIN (
               SELECT family_id, MAX(id) AS max_id
               FROM chat_messages
               WHERE deleted_at IS NULL AND chat_scope = 'support'
               GROUP BY family_id
             ) x ON m.family_id = x.family_id AND m.id = x.max_id
           ) lm ON lm.family_id = f.id
           LEFT JOIN chat_room_read_state rs
             ON rs.family_id = f.id
            AND rs.user_id = ?
            AND rs.chat_scope = 'support'
           ORDER BY f.id DESC`,
          [userId],
        );
        const familyIds = rows
          .map((r) => Number(r.family_id))
          .filter((id) => Number.isFinite(id) && id > 0);
        const membersByFamily = new Map();
        if (familyIds.length > 0) {
          const ph = familyIds.map(() => "?").join(",");
          const [memRows] = await pool.query(
            `SELECT fm.family_id, u.id AS user_id, u.display_name, u.login_name, u.email
             FROM family_members fm
             INNER JOIN users u ON u.id = fm.user_id
             WHERE fm.family_id IN (${ph})
             ORDER BY fm.family_id ASC, fm.id ASC`,
            familyIds,
          );
          for (const mem of memRows) {
            const fid = Number(mem.family_id);
            if (!Number.isFinite(fid)) continue;
            const list = membersByFamily.get(fid) ?? [];
            list.push({
              user_id: Number(mem.user_id),
              display_name: mem.display_name == null ? null : String(mem.display_name),
              login_name: mem.login_name == null ? null : String(mem.login_name),
              email: String(mem.email ?? ""),
            });
            membersByFamily.set(fid, list);
          }
        }
        const items = rows.map((r) => {
          const lastAt = r.last_message_at;
          const fid = Number(r.family_id);
          return {
            family_id: fid,
            family_name: String(r.family_name ?? ""),
            members: membersByFamily.get(fid) ?? [],
            last_message:
              r.last_message_id == null
                ? null
                : {
                    id: Number(r.last_message_id),
                    body: String(r.last_message_body ?? ""),
                    created_at:
                      lastAt instanceof Date ? lastAt.toISOString() : r.last_message_at ?? null,
                    sender_user_id: Number(r.last_sender_user_id),
                    is_staff: Number(r.last_is_staff) === 1,
                    is_important: Number(r.last_is_important) === 1,
                  },
            has_unread:
              r.last_message_id != null &&
              Number(r.last_is_staff) === 0 &&
              Number(r.last_message_id) > Number(r.admin_last_read_message_id ?? 0),
          };
        });
        return json(200, { items }, hdrs, skipCors);
      } catch (e) {
        if (isSupportChatDbConfigError(e)) {
          return json(503, supportChatMigrationNeededResponseBody(), hdrs, skipCors);
        }
        throw e;
      }
    }

    if (routeKey(method, path) === "GET /admin/support/chat/messages") {
      const admin = await ensureAdmin(pool, userId);
      if (!admin.ok) return json(admin.status, admin.body, hdrs, skipCors);
      const rawFam = q.family_id ?? q.familyId;
      if (rawFam == null || String(rawFam).trim() === "") {
        return json(400, { error: "family_id が必要です" }, hdrs, skipCors);
      }
      const targetFamilyId = Number(rawFam, 10);
      if (!Number.isFinite(targetFamilyId) || targetFamilyId <= 0) {
        return json(400, { error: "family_id が不正です" }, hdrs, skipCors);
      }
      const [[fam]] = await pool.query(`SELECT id FROM families WHERE id = ? LIMIT 1`, [
        targetFamilyId,
      ]);
      if (!fam) {
        return json(404, { error: "家族が見つかりません" }, hdrs, skipCors);
      }
      if (!(await familyIsInAdminUserDirectory(pool, targetFamilyId))) {
        return json(
          404,
          {
            error: "FamilyNotInAdminList",
            messageJa:
              "この家族は管理画面のユーザー一覧にいない（どのユーザーの既定家族IDでもない）ため、サポートチャット管理の対象外です。",
          },
          hdrs,
          skipCors,
        );
      }
      const limit = clampSupportChatLimit(q.limit, 50);
      const beforeRaw = q.before ?? q.before_id;
      const beforeId =
        beforeRaw != null && String(beforeRaw).trim() !== ""
          ? Number(beforeRaw, 10)
          : null;
      if (beforeId != null && (!Number.isFinite(beforeId) || beforeId <= 0)) {
        return json(400, { error: "before が不正です" }, hdrs, skipCors);
      }
      const fetchLimit = limit + 1;
      try {
        const [rows] =
          beforeId == null
            ? await pool.query(
                `SELECT id, family_id, sender_user_id, body, is_staff, is_important, created_at, edited_at
                 FROM chat_messages
                 WHERE family_id = ? AND chat_scope = 'support' AND deleted_at IS NULL
                 ORDER BY id DESC
                 LIMIT ?`,
                [targetFamilyId, fetchLimit],
              )
            : await pool.query(
                `SELECT id, family_id, sender_user_id, body, is_staff, is_important, created_at, edited_at
                 FROM chat_messages
                 WHERE family_id = ? AND chat_scope = 'support' AND deleted_at IS NULL AND id < ?
                 ORDER BY id DESC
                 LIMIT ?`,
                [targetFamilyId, beforeId, fetchLimit],
              );
        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const items = page.map(rowToChatMessageApi).reverse();
        const nextBeforeId =
          hasMore && items.length > 0 ? Number(items[0].id) : null;
        const read_states = await fetchChatReadStates(pool, targetFamilyId, "support");
        return json(
          200,
          {
            family_id: targetFamilyId,
            items,
            read_states,
            has_more: hasMore,
            next_before_id: nextBeforeId,
          },
          hdrs,
          skipCors,
        );
      } catch (e) {
        if (isSupportChatDbConfigError(e)) {
          return json(503, supportChatMigrationNeededResponseBody(), hdrs, skipCors);
        }
        throw e;
      }
    }

    if (routeKey(method, path) === "POST /admin/support/chat/messages") {
      const admin = await ensureAdmin(pool, userId);
      if (!admin.ok) return json(admin.status, admin.body, hdrs, skipCors);
      let b = {};
      try {
        b = JSON.parse(req.body || "{}");
      } catch {
        return json(400, { error: "JSON が不正です" }, hdrs, skipCors);
      }
      const rawFam = b.family_id ?? b.familyId;
      const targetFamilyId = Number(rawFam, 10);
      if (!Number.isFinite(targetFamilyId) || targetFamilyId <= 0) {
        return json(400, { error: "family_id が必要です" }, hdrs, skipCors);
      }
      const [[fam]] = await pool.query(`SELECT id FROM families WHERE id = ? LIMIT 1`, [
        targetFamilyId,
      ]);
      if (!fam) {
        return json(404, { error: "家族が見つかりません" }, hdrs, skipCors);
      }
      if (!(await familyIsInAdminUserDirectory(pool, targetFamilyId))) {
        return json(
          404,
          {
            error: "FamilyNotInAdminList",
            messageJa:
              "この家族は管理画面のユーザー一覧にいない（どのユーザーの既定家族IDでもない）ため、サポートチャット管理の対象外です。",
          },
          hdrs,
          skipCors,
        );
      }
      const normBody = normalizeSupportChatBody(b.body);
      if (normBody.error) {
        return json(400, { error: normBody.error }, hdrs, skipCors);
      }
      const isImportant =
        b.is_important === true ||
        b.isImportant === true ||
        b.important === true;
      try {
        const [ins] = await pool.query(
          `INSERT INTO chat_messages (family_id, sender_user_id, body, is_staff, is_important, chat_scope)
           VALUES (?, ?, ?, 1, ?, 'support')`,
          [targetFamilyId, userId, normBody.body, isImportant ? 1 : 0],
        );
        const newId = Number(ins.insertId);
        const [[row]] = await pool.query(
          `SELECT id, family_id, sender_user_id, body, is_staff, is_important, created_at, edited_at
           FROM chat_messages WHERE id = ? LIMIT 1`,
          [newId],
        );
        return json(201, { message: rowToChatMessageApi(row) }, hdrs, skipCors);
      } catch (e) {
        if (isSupportChatDbConfigError(e)) {
          return json(503, supportChatMigrationNeededResponseBody(), hdrs, skipCors);
        }
        throw e;
      }
    }

    if (adminSupportChatMessageOneMatch && method === "PATCH") {
      const admin = await ensureAdmin(pool, userId);
      if (!admin.ok) return json(admin.status, admin.body, hdrs, skipCors);
      const msgId = Number(adminSupportChatMessageOneMatch[1], 10);
      if (!Number.isFinite(msgId) || msgId <= 0) {
        return json(400, { error: "メッセージIDが不正です" }, hdrs, skipCors);
      }
      let b = {};
      try {
        b = JSON.parse(req.body || "{}");
      } catch {
        return json(400, { error: "JSON が不正です" }, hdrs, skipCors);
      }
      const hasImportant =
        Object.prototype.hasOwnProperty.call(b, "is_important") ||
        Object.prototype.hasOwnProperty.call(b, "isImportant");
      const hasBody = Object.prototype.hasOwnProperty.call(b, "body");
      if (!hasImportant && !hasBody) {
        return json(
          400,
          { error: "is_important または body を指定してください" },
          hdrs,
          skipCors,
        );
      }
      let normalizedBody = null;
      if (hasBody) {
        const norm = normalizeSupportChatBody(b.body);
        if (norm.error) {
          return json(400, { error: norm.error }, hdrs, skipCors);
        }
        normalizedBody = norm.body;
      }
      try {
        const [[exists]] = await pool.query(
          `SELECT is_staff, family_id FROM chat_messages WHERE id = ? AND chat_scope = 'support' AND deleted_at IS NULL LIMIT 1`,
          [msgId],
        );
        if (!exists) {
          return json(404, { error: "メッセージが見つかりません" }, hdrs, skipCors);
        }
        if (!(await familyIsInAdminUserDirectory(pool, exists.family_id))) {
          return json(
            404,
            {
              error: "FamilyNotInAdminList",
              messageJa:
                "このメッセージの家族は管理画面ユーザー一覧の対象外のため、編集できません。",
            },
            hdrs,
            skipCors,
          );
        }
        if (hasBody && Number(exists.is_staff) !== 1) {
          return json(
            400,
            { error: "管理者メッセージのみ本文を編集できます" },
            hdrs,
            skipCors,
          );
        }
        const fields = [];
        const params = [];
        if (hasImportant) {
          const flag = Boolean(b.is_important ?? b.isImportant);
          fields.push("is_important = ?");
          params.push(flag ? 1 : 0);
        }
        if (hasBody) {
          fields.push("body = ?");
          params.push(normalizedBody);
          fields.push("edited_at = NOW()");
        }
        const [upd] = await pool.query(
          `UPDATE chat_messages SET ${fields.join(", ")} WHERE id = ? AND chat_scope = 'support' AND deleted_at IS NULL`,
          [...params, msgId],
        );
        if (!upd?.affectedRows) {
          return json(404, { error: "メッセージが見つかりません" }, hdrs, skipCors);
        }
        const [[row]] = await pool.query(
          `SELECT id, family_id, sender_user_id, body, is_staff, is_important, created_at, edited_at
           FROM chat_messages WHERE id = ? LIMIT 1`,
          [msgId],
        );
        return json(200, { message: rowToChatMessageApi(row) }, hdrs, skipCors);
      } catch (e) {
        if (isSupportChatDbConfigError(e)) {
          return json(503, supportChatMigrationNeededResponseBody(), hdrs, skipCors);
        }
        throw e;
      }
    }

    if (adminSupportChatMessageOneMatch && method === "DELETE") {
      const admin = await ensureAdmin(pool, userId);
      if (!admin.ok) return json(admin.status, admin.body, hdrs, skipCors);
      const msgId = Number(adminSupportChatMessageOneMatch[1], 10);
      if (!Number.isFinite(msgId) || msgId <= 0) {
        return json(400, { error: "メッセージIDが不正です" }, hdrs, skipCors);
      }
      try {
        const [[row]] = await pool.query(
          `SELECT family_id FROM chat_messages WHERE id = ? AND chat_scope = 'support' AND deleted_at IS NULL LIMIT 1`,
          [msgId],
        );
        if (!row) {
          return json(404, { error: "メッセージが見つかりません" }, hdrs, skipCors);
        }
        if (!(await familyIsInAdminUserDirectory(pool, row.family_id))) {
          return json(
            404,
            {
              error: "FamilyNotInAdminList",
              messageJa:
                "このメッセージの家族は管理画面ユーザー一覧の対象外のため、削除できません。",
            },
            hdrs,
            skipCors,
          );
        }
        const [upd] = await pool.query(
          `UPDATE chat_messages SET deleted_at = NOW() WHERE id = ? AND chat_scope = 'support' AND deleted_at IS NULL`,
          [msgId],
        );
        if (!upd?.affectedRows) {
          return json(404, { error: "メッセージが見つかりません" }, hdrs, skipCors);
        }
        return json(200, { ok: true }, hdrs, skipCors);
      } catch (e) {
        if (isSupportChatDbConfigError(e)) {
          return json(503, supportChatMigrationNeededResponseBody(), hdrs, skipCors);
        }
        throw e;
      }
    }

    if (categoryOneMatch && method === "PATCH") {
      const categoryId = Number(categoryOneMatch[1], 10);
      if (!Number.isFinite(categoryId) || categoryId <= 0) {
        return json(400, { error: "カテゴリIDが不正です" }, hdrs, skipCors);
      }
      const b = JSON.parse(req.body || "{}");
      const catPatchSubRej = rejectNonAdminSubscriptionBodyFields(b, hdrs, skipCors);
      if (catPatchSubRej) return catPatchSubRej;
      const [[cur]] = await pool.query(
        `SELECT c.name, c.kind, c.is_medical_default, c.default_medical_type, c.default_patient_name FROM categories c
         WHERE c.id = ? AND (${catWhere}) AND c.is_archived = 0 LIMIT 1`,
        [categoryId, userId, userId],
      );
      if (!cur) {
        return json(404, { error: "カテゴリが見つかりません" }, hdrs, skipCors);
      }
      const fields = [];
      const params = [];
      if (Object.prototype.hasOwnProperty.call(b, "name")) {
        const raw = b.name == null ? "" : String(b.name).trim();
        if (raw.length < 1 || raw.length > 100) {
          return json(400, { error: "name は1〜100文字で指定してください" }, hdrs, skipCors);
        }
        fields.push("name = ?");
        params.push(raw);
      }
      if (Object.prototype.hasOwnProperty.call(b, "kind")) {
        if (b.kind !== "expense" && b.kind !== "income") {
          return json(400, { error: "kind は expense または income です" }, hdrs, skipCors);
        }
        fields.push("kind = ?");
        params.push(b.kind);
      }
      if (Object.prototype.hasOwnProperty.call(b, "color_hex")) {
        const ch = b.color_hex == null || b.color_hex === "" ? null : String(b.color_hex).trim();
        if (ch != null && !/^#[0-9A-Fa-f]{6}$/.test(ch)) {
          return json(400, { error: "color_hex は #RRGGBB 形式で指定してください" }, hdrs, skipCors);
        }
        fields.push("color_hex = ?");
        params.push(ch);
      }
      if (Object.prototype.hasOwnProperty.call(b, "sort_order")) {
        const so = Number(b.sort_order);
        if (!Number.isFinite(so)) {
          return json(400, { error: "sort_order が不正です" }, hdrs, skipCors);
        }
        fields.push("sort_order = ?");
        params.push(so);
      }
      if (Object.prototype.hasOwnProperty.call(b, "is_archived")) {
        if (typeof b.is_archived !== "boolean") {
          return json(400, { error: "is_archived は boolean で指定してください" }, hdrs, skipCors);
        }
        fields.push("is_archived = ?");
        params.push(b.is_archived ? 1 : 0);
      }
      if (Object.prototype.hasOwnProperty.call(b, "is_medical_default")) {
        if (typeof b.is_medical_default !== "boolean") {
          return json(400, { error: "is_medical_default は boolean で指定してください" }, hdrs, skipCors);
        }
        fields.push("is_medical_default = ?");
        params.push(b.is_medical_default ? 1 : 0);
      }
      if (Object.prototype.hasOwnProperty.call(b, "default_medical_type")) {
        const mt = normalizeMedicalType(b.default_medical_type);
        if (b.default_medical_type != null && b.default_medical_type !== "" && mt == null) {
          return json(
            400,
            { error: "default_medical_type は treatment / medicine / other のいずれかです" },
            hdrs,
            skipCors,
          );
        }
        fields.push("default_medical_type = ?");
        params.push(mt);
      }
      if (Object.prototype.hasOwnProperty.call(b, "default_patient_name")) {
        const patient = normalizeMedicalPatientName(b.default_patient_name);
        fields.push("default_patient_name = ?");
        params.push(patient);
      }
      if (fields.length === 0) {
        return json(400, { error: "更新項目がありません" }, hdrs, skipCors);
      }
      const nextName = Object.prototype.hasOwnProperty.call(b, "name")
        ? String(b.name).trim()
        : String(cur.name ?? "");
      const nextKind =
        Object.prototype.hasOwnProperty.call(b, "kind") &&
        (b.kind === "expense" || b.kind === "income")
          ? b.kind
          : String(cur.kind ?? "expense");
      const nextMedicalDefault = Object.prototype.hasOwnProperty.call(b, "is_medical_default")
        ? Boolean(b.is_medical_default)
        : Number(cur.is_medical_default) === 1;
      const nextDefaultMedicalType = Object.prototype.hasOwnProperty.call(b, "default_medical_type")
        ? normalizeMedicalType(b.default_medical_type)
        : normalizeMedicalType(cur.default_medical_type);
      if (nextMedicalDefault && nextDefaultMedicalType == null) {
        return json(
          400,
          { error: "医療費対象カテゴリにする場合は default_medical_type を指定してください" },
          hdrs,
          skipCors,
        );
      }
      if (
        Object.prototype.hasOwnProperty.call(b, "name") ||
        Object.prototype.hasOwnProperty.call(b, "kind")
      ) {
        const dupId = await findDuplicateCategoryId(
          pool,
          userId,
          catWhere,
          nextKind,
          nextName,
          categoryId,
        );
        if (dupId != null) {
          return json(
            409,
            {
              error: "同じ名前のカテゴリが既にあります",
              existing_id: dupId,
            },
            hdrs,
            skipCors,
          );
        }
      }
      const [upd] = await pool.query(
        `UPDATE categories c SET ${fields.join(", ")}, updated_at = NOW()
         WHERE c.id = ? AND (${catWhere})`,
        [...params, categoryId, userId, userId],
      );
      if (!upd?.affectedRows) {
        return json(404, { error: "カテゴリが見つかりません" }, hdrs, skipCors);
      }
      return json(200, { ok: true }, hdrs, skipCors);
    }

    if (categoryOneMatch && method === "DELETE") {
      const categoryId = Number(categoryOneMatch[1], 10);
      if (!Number.isFinite(categoryId) || categoryId <= 0) {
        return json(400, { error: "カテゴリIDが不正です" }, hdrs, skipCors);
      }
      const [upd] = await pool.query(
        `UPDATE categories c SET is_archived = 1, updated_at = NOW()
         WHERE c.id = ? AND (${catWhere}) AND c.is_archived = 0`,
        [categoryId, userId, userId],
      );
      if (!upd?.affectedRows) {
        return json(404, { error: "カテゴリが見つかりません" }, hdrs, skipCors);
      }
      return json(200, { ok: true }, hdrs, skipCors);
    }

    switch (routeKey(method, path)) {
      case "GET /categories": {
        await seedDefaultCategoriesIfEmpty(pool, userId, familyId);
        try {
          await mergeDuplicateCategories(pool, userId, catWhere, txWhere, txP2);
        } catch (e) {
          logError("categories.merge_duplicates", e);
        }
        const [rows] = await pool.query(
          `SELECT c.id, c.parent_id, c.name, c.kind, c.color_hex, c.sort_order, c.is_archived,
                  c.is_medical_default, c.default_medical_type, c.default_patient_name,
                  c.created_at, c.updated_at
           FROM categories c
           WHERE ${catWhere} AND c.is_archived = 0
           ORDER BY c.kind, c.sort_order, c.id`,
          [userId, userId],
        );
        return json(200, { items: rows }, hdrs, skipCors);
      }

      case "POST /categories/ensure-defaults": {
        const r = await seedDefaultCategoriesIfEmpty(pool, userId, familyId);
        return json(200, { ok: true, inserted: r.inserted }, hdrs, skipCors);
      }

      case "GET /billing/subscription-status": {
        const subRow = await loadUserSubscriptionRowFull(pool, userId);
        let statusFromAdminMap = null;
        try {
          const subMap = await fetchAdminUsersSubscriptionStatusMap(pool);
          if (subMap.has(Number(userId))) {
            const v = subMap.get(Number(userId));
            if (v != null && String(v).trim() !== "") {
              statusFromAdminMap = String(v).trim();
            }
          }
        } catch {
          /* fallback to subRow */
        }
        const subscriptionStatus = statusFromAdminMap
          ? getEffectiveSubscriptionStatus(statusFromAdminMap, userId)
          : getEffectiveSubscriptionStatus(
              deriveSubscriptionStatusFromDbRow(subRow),
              userId,
            );
        let periodEndAt =
          subRow?.subscription_period_end_at != null &&
          String(subRow.subscription_period_end_at).trim() !== ""
            ? String(subRow.subscription_period_end_at)
            : null;
        if (!periodEndAt) {
          try {
            const st = String(subscriptionStatus ?? "").trim().toLowerCase();
            const atEnd = Number(subRow?.subscription_cancel_at_period_end) === 1;
            if (
              atEnd ||
              st === "active" ||
              st === "trialing" ||
              st === "past_due" ||
              st === "canceled"
            ) {
              const fromStripe = await fetchSubscriptionPeriodEndIsoFromStripeLive(pool, userId);
              if (fromStripe) {
                periodEndAt = fromStripe;
              }
            }
          } catch (e) {
            logError("billing.subscription_status.stripe_period_enrich", e, { userId });
          }
        }
        return json(
          200,
          {
            subscriptionStatus,
            subscriptionPeriodEndAt: periodEndAt,
            subscriptionCancelAtPeriodEnd:
              subRow?.subscription_cancel_at_period_end === true ||
              Number(subRow?.subscription_cancel_at_period_end) === 1,
          },
          hdrs,
          skipCors,
        );
      }

      case "POST /billing/checkout-session": {
        const b = JSON.parse(req.body || "{}");
        const billSubRej = rejectNonAdminSubscriptionBodyFields(b, hdrs, skipCors);
        if (billSubRej) return billSubRej;
        try {
          const url = await createBillingCheckoutSession(pool, userId, b);
          return json(200, { url }, hdrs, skipCors);
        } catch (e) {
          const msg = String(e?.message || e);
          if (
            msg.includes("設定してください") ||
            msg.includes("STRIPE_") ||
            msg.includes("sk_test_")
          ) {
            return json(
              503,
              { error: "StripeCheckoutUnavailable", detail: msg },
              hdrs,
              skipCors,
            );
          }
          if (
            msg.includes("許可リスト") ||
            msg.includes("URL") ||
            msg.includes("successUrl") ||
            msg.includes("cancelUrl") ||
            msg.includes("既に有効なサブスクリプション")
          ) {
            return json(
              400,
              { error: "InvalidRequest", detail: msg },
              hdrs,
              skipCors,
            );
          }
          logError("billing.checkout_session", e);
          return json(
            500,
            { error: "InternalError", detail: msg },
            hdrs,
            skipCors,
          );
        }
      }

      case "POST /billing/portal-session": {
        const b = JSON.parse(req.body || "{}");
        const portalSubRej = rejectNonAdminSubscriptionBodyFields(b, hdrs, skipCors);
        if (portalSubRej) return portalSubRej;
        try {
          const url = await createBillingPortalSession(pool, userId, b);
          return json(200, { url }, hdrs, skipCors);
        } catch (e) {
          const msg = String(e?.message || e);
          if (
            msg.includes("未登録") ||
            msg.includes("顧客") ||
            msg.includes("契約") ||
            msg.includes("再同期しました") ||
            msg.includes("returnUrl")
          ) {
            return json(
              400,
              { error: "BillingPortalUnavailable", detail: msg },
              hdrs,
              skipCors,
            );
          }
          if (msg.includes("許可リスト") || msg.includes("URL")) {
            return json(
              400,
              { error: "InvalidRequest", detail: msg },
              hdrs,
              skipCors,
            );
          }
          if (msg.includes("STRIPE_") || msg.includes("設定")) {
            return json(
              503,
              { error: "StripeUnavailable", detail: msg },
              hdrs,
              skipCors,
            );
          }
          logError("billing.portal_session", e);
          return json(
            500,
            { error: "InternalError", detail: msg },
            hdrs,
            skipCors,
          );
        }
      }

      case "POST /billing/cancel-subscription": {
        const b = JSON.parse(req.body || "{}");
        const canSubRej = rejectNonAdminSubscriptionBodyFields(b, hdrs, skipCors);
        if (canSubRej) return canSubRej;
        try {
          const r = await cancelUserSubscriptionAtPeriodEnd(pool, userId);
          return json(200, r, hdrs, skipCors);
        } catch (e) {
          const msg = String(e?.message || e);
          if (
            msg.includes("未登録") ||
            msg.includes("対象") ||
            msg.includes("ありません")
          ) {
            return json(
              400,
              { error: "BillingCancelUnavailable", detail: msg },
              hdrs,
              skipCors,
            );
          }
          if (msg.includes("STRIPE_") || msg.includes("設定")) {
            return json(
              503,
              { error: "StripeUnavailable", detail: msg },
              hdrs,
              skipCors,
            );
          }
          logError("billing.cancel_subscription", e);
          return json(
            500,
            { error: "InternalError", detail: msg },
            hdrs,
            skipCors,
          );
        }
      }

      case "POST /categories": {
        const b = JSON.parse(req.body || "{}");
        const catSubRej = rejectNonAdminSubscriptionBodyFields(b, hdrs, skipCors);
        if (catSubRej) return catSubRej;
        const rawName = b.name == null ? "" : String(b.name).trim();
        if (rawName.length < 1 || rawName.length > 100) {
          return json(400, { error: "name は1〜100文字で指定してください" }, hdrs, skipCors);
        }
        const kind = b.kind === "income" ? "income" : "expense";
        const ch =
          b.color_hex == null || b.color_hex === ""
            ? null
            : String(b.color_hex).trim();
        if (ch != null && !/^#[0-9A-Fa-f]{6}$/.test(ch)) {
          return json(400, { error: "color_hex は #RRGGBB 形式で指定してください" }, hdrs, skipCors);
        }
        const so = b.sort_order != null ? Number(b.sort_order) : 0;
        if (!Number.isFinite(so)) {
          return json(400, { error: "sort_order が不正です" }, hdrs, skipCors);
        }
        const isMedicalDefault = b.is_medical_default === true;
        const defaultMedicalType = normalizeMedicalType(b.default_medical_type);
        if (isMedicalDefault && defaultMedicalType == null) {
          return json(
            400,
            { error: "医療費対象カテゴリにする場合は default_medical_type を指定してください" },
            hdrs,
            skipCors,
          );
        }
        if (
          b.default_medical_type != null &&
          b.default_medical_type !== "" &&
          defaultMedicalType == null
        ) {
          return json(
            400,
            { error: "default_medical_type は treatment / medicine / other のいずれかです" },
            hdrs,
            skipCors,
          );
        }
        const defaultPatientName = normalizeMedicalPatientName(b.default_patient_name);
        const dupId = await findDuplicateCategoryId(
          pool,
          userId,
          catWhere,
          kind,
          rawName,
          null,
        );
        if (dupId != null) {
          return json(
            409,
            {
              error: "同じ名前のカテゴリが既にあります",
              existing_id: dupId,
            },
            hdrs,
            skipCors,
          );
        }
        const [r] = await pool.query(
          `INSERT INTO categories (
             user_id, family_id, parent_id, name, kind, color_hex, sort_order,
             is_medical_default, default_medical_type, default_patient_name
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            userId,
            familyId,
            b.parent_id ?? null,
            rawName,
            kind,
            ch,
            so,
            isMedicalDefault ? 1 : 0,
            isMedicalDefault ? defaultMedicalType : null,
            isMedicalDefault ? defaultPatientName : null,
          ],
        );
        return json(201, { id: r.insertId }, hdrs, skipCors);
      }

      case "GET /transactions": {
        const from = q.from;
        const to = q.to;
        const familyScopeOnly = String(q.scope ?? "").toLowerCase() === "family";
        const useKidWatchLedger = familyScopeOnly && kidWatchLedger.active;
        const txWhereForScope = familyScopeOnly
          ? useKidWatchLedger
            ? txWhereFamilyKidWatch
            : txWhereFamily
          : txWhere;
        let sql = `SELECT t.id, t.account_id, t.category_id, t.kind, t.amount, t.transaction_date, t.memo,
                          t.is_medical_expense, t.medical_type, t.medical_patient_name,
                          t.created_at, t.updated_at, t.user_id
                   FROM transactions t
                   WHERE ${txWhereForScope}`;
        const params = [
          ...(familyScopeOnly ? (useKidWatchLedger ? txP1KidWatch : txP1) : txP2),
        ];
        if (from) {
          sql += ` AND t.transaction_date >= ?`;
          params.push(from);
        }
        if (to) {
          sql += ` AND t.transaction_date <= ?`;
          params.push(to);
        }
        sql += ` ORDER BY t.transaction_date DESC, t.id DESC LIMIT 500`;
        const [rows] = await pool.query(sql, params);
        return json(200, { items: rows }, hdrs, skipCors);
      }

      case "POST /transactions": {
        const b = JSON.parse(req.body || "{}");
        const txSubRej = rejectNonAdminSubscriptionBodyFields(b, hdrs, skipCors);
        if (txSubRej) return txSubRej;
        const kind = b.kind === "income" ? "income" : "expense";
        if (
          !Object.prototype.hasOwnProperty.call(b, "amount") ||
          b.amount === null ||
          b.amount === ""
        ) {
          return json(400, { error: "金額（amount）が必要です" }, hdrs, skipCors);
        }
        const amt = Number(b.amount);
        const v = validateTransactionAmount(kind, amt);
        if (!v.ok) {
          return json(400, { error: v.error }, hdrs, skipCors);
        }
        const txDate = String(b.transaction_date ?? "").slice(0, 10);
        if (!txDate) {
          return json(400, { error: "transaction_date が必要です" }, hdrs, skipCors);
        }
        let categoryId = null;
        if (b.category_id != null && b.category_id !== "") {
          categoryId = Number(b.category_id);
          if (!Number.isFinite(categoryId)) {
            return json(400, { error: "category_id が不正です" }, hdrs, skipCors);
          }
        }
        const catFixedPost = await rejectExpenseUsingLedgerFixedCategory(
          pool,
          catWhere,
          [userId, userId],
          kind,
          categoryId,
        );
        if (catFixedPost) {
          return json(400, { error: catFixedPost }, hdrs, skipCors);
        }
        const memo = normalizeTxMemo(b.memo);
        const medicalFieldSpecified = isMedicalFieldSpecified(b);
        let isMedicalExpense = false;
        let medicalType = null;
        let medicalPatientName = null;
        if (medicalFieldSpecified) {
          if (
            Object.prototype.hasOwnProperty.call(b, "is_medical_expense") &&
            typeof b.is_medical_expense !== "boolean"
          ) {
            return json(400, { error: "is_medical_expense は boolean で指定してください" }, hdrs, skipCors);
          }
          isMedicalExpense = b.is_medical_expense === true;
          medicalType = normalizeMedicalType(b.medical_type);
          if (b.medical_type != null && b.medical_type !== "" && medicalType == null) {
            return json(
              400,
              { error: "medical_type は treatment / medicine / other のいずれかです" },
              hdrs,
              skipCors,
            );
          }
          medicalPatientName = normalizeMedicalPatientName(b.medical_patient_name);
        } else if (kind === "expense" && categoryId != null) {
          const autoMedical = await resolveMedicalDefaultsFromCategory(
            pool,
            catWhere,
            userId,
            categoryId,
          );
          isMedicalExpense = autoMedical.isMedicalExpense;
          medicalType = autoMedical.medicalType;
          medicalPatientName = autoMedical.medicalPatientName;
        }
        if (isMedicalExpense && medicalType == null) {
          return json(400, { error: "medical_type を選択してください" }, hdrs, skipCors);
        }
        if (!isMedicalExpense) {
          medicalType = null;
          medicalPatientName = null;
        }
        const fromReceipt = b.from_receipt === true || b.from_receipt === "true";
        if (fromReceipt) {
          const [exactRows] = await pool.query(
            `SELECT t.id FROM transactions t
             WHERE t.user_id = ?
               AND t.kind = ?
               AND t.transaction_date = ?
               AND t.amount = ?
               AND (t.memo <=> ?)
             LIMIT 1`,
            [userId, kind, txDate, amt, memo],
          );
          if (Array.isArray(exactRows) && exactRows.length > 0) {
            return json(
              409,
              {
                error: "AlreadyRegistered",
                detail: "既に登録済です",
              },
              hdrs,
              skipCors,
            );
          }
        }
        const [dupRows] = await pool.query(
          `SELECT t.id, t.amount
           FROM transactions t
           WHERE t.user_id = ?
             AND t.kind = ?
             AND t.transaction_date = ?
             AND (t.category_id <=> ?)
             AND (t.memo <=> ?)
             AND (t.is_medical_expense <=> ?)
             AND (t.medical_type <=> ?)
             AND (t.medical_patient_name <=> ?)
           ORDER BY t.id DESC
           LIMIT 1`,
          [
            userId,
            kind,
            txDate,
            categoryId,
            memo,
            isMedicalExpense ? 1 : 0,
            medicalType,
            medicalPatientName,
          ],
        );
        const dup = Array.isArray(dupRows) && dupRows.length > 0 ? dupRows[0] : null;
        if (dup) {
          const mergedAmount = Number(dup.amount ?? 0) + Number(amt);
          const mergedValidation = validateTransactionAmount(kind, mergedAmount);
          if (!mergedValidation.ok) {
            return json(400, { error: mergedValidation.error }, hdrs, skipCors);
          }
          await pool.query(
            `UPDATE transactions
             SET amount = ?, updated_at = NOW()
             WHERE id = ? AND user_id = ?`,
            [mergedAmount, dup.id, userId],
          );
          return json(200, { id: Number(dup.id), merged: true }, hdrs, skipCors);
        }
        const [r] = await pool.query(
          `INSERT INTO transactions
           (user_id, family_id, account_id, category_id, kind, amount, transaction_date, memo,
            is_medical_expense, medical_type, medical_patient_name, external_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            userId,
            familyId,
            b.account_id ?? null,
            categoryId,
            kind,
            amt,
            txDate,
            memo,
            isMedicalExpense ? 1 : 0,
            medicalType,
            medicalPatientName,
            b.external_id ?? null,
          ],
        );
        return json(201, { id: r.insertId }, hdrs, skipCors);
      }

      case "POST /transactions/delete": {
        const b = JSON.parse(req.body || "{}");
        const txDelSubRej = rejectNonAdminSubscriptionBodyFields(b, hdrs, skipCors);
        if (txDelSubRej) return txDelSubRej;
        const txId = Number(b.id);
        if (!Number.isFinite(txId) || txId <= 0) {
          return json(400, { error: "id が不正です" }, hdrs, skipCors);
        }
        const [delRes] = await pool.query(
          `DELETE t FROM transactions t WHERE t.id = ? AND (${txWhere})`,
          [txId, ...txP2],
        );
        if (!delRes.affectedRows) {
          return json(404, { error: "見つかりません" }, hdrs, skipCors);
        }
        return json(200, { ok: true }, hdrs, skipCors);
      }

      case "POST /transactions/delete-bulk": {
        const b = JSON.parse(req.body || "{}");
        const txDelSubRej = rejectNonAdminSubscriptionBodyFields(b, hdrs, skipCors);
        if (txDelSubRej) return txDelSubRej;
        const idsRaw = Array.isArray(b.ids) ? b.ids : [];
        const ids = [...new Set(idsRaw.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0))];
        if (ids.length === 0) {
          return json(400, { error: "ids が不正です" }, hdrs, skipCors);
        }
        const placeholders = ids.map(() => "?").join(",");
        const [delRes] = await pool.query(
          `DELETE t FROM transactions t
           WHERE t.id IN (${placeholders}) AND (${txWhere})`,
          [...ids, ...txP2],
        );
        const deleted = Number(delRes?.affectedRows ?? 0);
        return json(200, { ok: true, deleted }, hdrs, skipCors);
      }

      case "GET /summary/month": {
        const ym = q.year_month || q.yearMonth;
        const familyScopeOnly = String(q.scope ?? "").toLowerCase() === "family";
        const useKidWatchLedger = familyScopeOnly && kidWatchLedger.active;
        const txWhereForScope = familyScopeOnly
          ? useKidWatchLedger
            ? txWhereFamilyKidWatch
            : txWhereFamily
          : txWhere;
        const txScopeParams = familyScopeOnly
          ? useKidWatchLedger
            ? txP1KidWatch
            : txP1
          : txP2;
        const bounds = ymBounds(ym);
        if (!bounds) {
          return json(
            400,
            { error: "year_month=YYYY-MM が必要です" },
            hdrs,
            skipCors,
          );
        }
        const { from, to } = bounds;
        const [expRows] = await pool.query(
          `SELECT c.id AS category_id, c.name AS category_name, COALESCE(SUM(t.amount),0) AS total
           FROM transactions t
           LEFT JOIN categories c ON c.id = t.category_id
           WHERE ${txWhereForScope}
           AND t.transaction_date >= ? AND t.transaction_date <= ?
           AND t.kind = 'expense'
           AND (t.category_id IS NULL OR TRIM(IFNULL(c.name, '')) <> ?)
           GROUP BY c.id, c.name
           ORDER BY total DESC`,
          [...txScopeParams, from, to, RESERVED_LEDGER_FIXED_COST_CATEGORY],
        );
        const [incRows] = await pool.query(
          `SELECT c.id AS category_id, c.name AS category_name, COALESCE(SUM(t.amount),0) AS total
           FROM transactions t
           LEFT JOIN categories c ON c.id = t.category_id
           WHERE ${txWhereForScope}
           AND t.transaction_date >= ? AND t.transaction_date <= ?
           AND t.kind = 'income'
           GROUP BY c.id, c.name
           ORDER BY total DESC`,
          [...txScopeParams, from, to],
        );
        const [[sumE]] = await pool.query(
          `SELECT COALESCE(SUM(t.amount),0) AS total FROM transactions t
           LEFT JOIN categories c ON c.id = t.category_id
           WHERE ${txWhereForScope}
           AND t.transaction_date >= ? AND t.transaction_date <= ? AND t.kind = 'expense'
           AND (t.category_id IS NULL OR TRIM(IFNULL(c.name, '')) <> ?)`,
          [...txScopeParams, from, to, RESERVED_LEDGER_FIXED_COST_CATEGORY],
        );
        const [[sumI]] = await pool.query(
          `SELECT COALESCE(SUM(t.amount),0) AS total FROM transactions t
           WHERE ${txWhereForScope}
           AND t.transaction_date >= ? AND t.transaction_date <= ? AND t.kind = 'income'`,
          [...txScopeParams, from, to],
        );
        let fixedCostFromSettings = 0;
        if (familyScopeOnly && familyId && !isKidTxScope && !kidWatchLedger.active) {
          const memberOkSum = await verifyUserInFamily(pool, userId, familyId);
          if (memberOkSum) {
            fixedCostFromSettings = await familyFixedCostMonthlySum(pool, familyId);
          }
        }
        const incNum = Number(sumI?.total ?? 0);
        const varExpNum = Number(sumE?.total ?? 0);
        /** 収入も変動費も0の月は固定費を収支に含めない */
        const fixedInNet =
          incNum > 0 || varExpNum > 0 ? fixedCostFromSettings : 0;
        const netMonthlyBalance = incNum - varExpNum - fixedInNet;
        return json(
          200,
          {
            year_month: ym,
            from,
            to,
            expenseTotal: sumE.total,
            incomeTotal: sumI.total,
            fixedCostFromSettings,
            netMonthlyBalance,
            expensesByCategory: expRows,
            incomesByCategory: incRows,
          },
          hdrs,
          skipCors,
        );
      }

      case "GET /summary/balance": {
        const to = String(q.to ?? "").slice(0, 10);
        if (!to || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
          return json(
            400,
            { error: "to=YYYY-MM-DD が必要です" },
            hdrs,
            skipCors,
          );
        }
        const familyScopeOnly = String(q.scope ?? "").toLowerCase() === "family";
        const useKidWatchLedger = familyScopeOnly && kidWatchLedger.active;
        const txWhereForScope = familyScopeOnly
          ? useKidWatchLedger
            ? txWhereFamilyKidWatch
            : txWhereFamily
          : txWhere;
        const txScopeParams = familyScopeOnly
          ? useKidWatchLedger
            ? txP1KidWatch
            : txP1
          : txP2;
        const [[sumE]] = await pool.query(
          `SELECT COALESCE(SUM(t.amount),0) AS total FROM transactions t
           LEFT JOIN categories c ON c.id = t.category_id
           WHERE ${txWhereForScope}
           AND t.transaction_date <= ? AND t.kind = 'expense'
           AND (t.category_id IS NULL OR TRIM(IFNULL(c.name, '')) <> ?)`,
          [...txScopeParams, to, RESERVED_LEDGER_FIXED_COST_CATEGORY],
        );
        const [[sumI]] = await pool.query(
          `SELECT COALESCE(SUM(t.amount),0) AS total FROM transactions t
           WHERE ${txWhereForScope}
           AND t.transaction_date <= ? AND t.kind = 'income'`,
          [...txScopeParams, to],
        );
        const expenseVariableTotal = Number(sumE?.total ?? 0);
        const incomeTotal = Number(sumI?.total ?? 0);
        let balance = incomeTotal - expenseVariableTotal;
        if (familyScopeOnly && familyId && !isKidTxScope && !kidWatchLedger.active) {
          const memberOkBal = await verifyUserInFamily(pool, userId, familyId);
          if (memberOkBal) {
            const fixedSum = await familyFixedCostMonthlySum(pool, familyId);
            if (fixedSum > 0) {
              const [[firstRow]] = await pool.query(
                `SELECT MIN(t.transaction_date) AS d FROM transactions t WHERE ${txWhereForScope}`,
                [...txScopeParams],
              );
              const d0 = firstRow?.d;
              if (d0) {
                const fromYm = String(d0).slice(0, 7);
                const toYm = to.slice(0, 7);
                const months = inclusiveMonthSpan(fromYm, toYm);
                balance -= fixedSum * months;
              }
            }
          }
        }
        return json(
          200,
          {
            to,
            expenseTotal: expenseVariableTotal,
            incomeTotal,
            balance,
          },
          hdrs,
          skipCors,
        );
      }

      case "GET /settings/fixed-costs": {
        if (isKidTxScope) {
          return json(403, { error: "この操作はできません" }, hdrs, skipCors);
        }
        if (!familyId) {
          return json(
            400,
            { error: "家族が設定されていません" },
            hdrs,
            skipCors,
          );
        }
        const memberOk = await verifyUserInFamily(pool, userId, familyId);
        if (!memberOk) {
          return json(403, { error: "この家族の固定費を参照する権限がありません" }, hdrs, skipCors);
        }
        const [rows] = await pool.query(
          `SELECT id, label AS category, amount, sort_order
           FROM family_fixed_cost_items
           WHERE family_id = ?
           ORDER BY sort_order ASC, id ASC`,
          [familyId],
        );
        return json(200, { items: rows }, hdrs, skipCors);
      }

      case "PUT /settings/fixed-costs": {
        if (isKidTxScope) {
          return json(403, { error: "この操作はできません" }, hdrs, skipCors);
        }
        if (!familyId) {
          return json(
            400,
            { error: "家族が設定されていません" },
            hdrs,
            skipCors,
          );
        }
        const memberOkPut = await verifyUserInFamily(pool, userId, familyId);
        if (!memberOkPut) {
          return json(403, { error: "この家族の固定費を保存する権限がありません" }, hdrs, skipCors);
        }
        let b;
        try {
          b = JSON.parse(req.body || "{}");
        } catch {
          return json(400, { error: "JSON が不正です" }, hdrs, skipCors);
        }
        const fixedSubRej = rejectNonAdminSubscriptionBodyFields(b, hdrs, skipCors);
        if (fixedSubRej) return fixedSubRej;
        const rawItems = Array.isArray(b.items) ? b.items : [];
        if (rawItems.length > 200) {
          return json(400, { error: "固定費は200行までです" }, hdrs, skipCors);
        }
        const normalized = [];
        for (let i = 0; i < rawItems.length; i += 1) {
          const row = rawItems[i];
          const labelRaw =
            row?.label != null && row.label !== ""
              ? String(row.label)
              : String(row?.category ?? "");
          const label = labelRaw.trim().slice(0, 100);
          const amount = Math.max(0, Math.round(Number(row?.amount ?? 0)));
          if (label.length === 0 || amount <= 0) continue;
          normalized.push({ label, amount });
        }
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          await conn.query(`DELETE FROM family_fixed_cost_items WHERE family_id = ?`, [
            familyId,
          ]);
          for (let i = 0; i < normalized.length; i += 1) {
            const { label, amount } = normalized[i];
            await conn.query(
              `INSERT INTO family_fixed_cost_items (family_id, label, amount, sort_order)
               VALUES (?, ?, ?, ?)`,
              [familyId, label, amount, i],
            );
          }
          await conn.commit();
        } catch (e) {
          await conn.rollback();
          logError("settings.fixed-costs.put", e);
          return json(500, { error: "固定費の保存に失敗しました" }, hdrs, skipCors);
        } finally {
          conn.release();
        }
        return json(200, { ok: true }, hdrs, skipCors);
      }

      case "POST /ai/advisor": {
        const b = JSON.parse(req.body || "{}");
        const advSubRej = rejectNonAdminSubscriptionBodyFields(b, hdrs, skipCors);
        if (advSubRej) return advSubRej;
        const message = String(b.message ?? "").trim();
        if (!message) {
          return json(400, { error: "message が必要です" }, hdrs, skipCors);
        }
        const ctx = b.context && typeof b.context === "object" ? b.context : {};
        let bedrockDetail = "";
        let aiResult = null;
        let bedrockThrown = null;
        try {
          aiResult = await askBedrockAdvisor(message, ctx);
          if (aiResult?.ok && aiResult.reply) {
            return json(200, { ok: true, reply: aiResult.reply, source: "bedrock" }, hdrs, skipCors);
          }
          if (aiResult && !aiResult.ok) {
            const detailParts = [aiResult.code, aiResult.message].filter(Boolean);
            bedrockDetail =
              detailParts.join(": ").slice(0, 280) || "モデル応答を取得できませんでした";
            logError(
              "ai.advisor.bedrock",
              new Error(`${aiResult.code}: ${aiResult.message}`),
              {
                authFailed: !!aiResult.authFailed,
                throttled: !!aiResult.throttled,
                validationFailed: !!aiResult.validationFailed,
                attemptsLog: aiResult.attemptsLog,
              },
            );
          }
        } catch (e) {
          bedrockThrown = e;
          const msg = e instanceof Error ? e.message : String(e);
          const authFailed =
            msg.includes("AuthError") ||
            msg.includes("AccessDeniedException") ||
            msg.includes("ExpiredTokenException") ||
            msg.includes("UnrecognizedClientException");
          const throttled =
            msg.includes("RateLimitError") ||
            msg.includes("ThrottlingException") ||
            msg.includes("TooManyRequestsException");
          const validationFailed =
            msg.includes("ValidationException") || (e && e.name === "ValidationException");
          bedrockDetail = authFailed
            ? `AccessDeniedException: ${msg.slice(0, 220)}`
            : throttled
              ? `ThrottlingException: ${msg.slice(0, 220)}`
              : validationFailed
                ? `ValidationException: ${msg.slice(0, 220)}`
                : `モデル応答エラー: ${msg.slice(0, 220)}`;
          logError("ai.advisor.bedrock", e, {
            authFailed,
            throttled,
            validationFailed,
          });
        }

        const debugAdvisor =
          String(process.env.AI_ADVISOR_DEBUG_ERRORS ?? "").trim() === "1";
        if (debugAdvisor) {
          const stack =
            bedrockThrown instanceof Error
              ? String(bedrockThrown.stack || bedrockThrown.message)
              : bedrockThrown != null
                ? String(bedrockThrown)
                : "";
          const attemptsSnippet =
            aiResult?.attemptsLog != null
              ? JSON.stringify(aiResult.attemptsLog).slice(0, 3500)
              : "";
          const reply = [
            "[AIアドバイザー デバッグ] モデル応答を取得できませんでした。",
            "",
            "概要:",
            bedrockDetail || "(詳細なし)",
            "",
            stack ? "スタック:\n" + stack.slice(0, 6000) : "",
            attemptsSnippet ? "\n試行ログ（抜粋）:\n" + attemptsSnippet : "",
          ]
            .filter(Boolean)
            .join("\n")
            .slice(0, 12000);
          return json(
            200,
            {
              ok: true,
              reply,
              source: "error",
              sourceDetail: bedrockDetail,
              advisorDebug: true,
            },
            hdrs,
            skipCors,
          );
        }

        const reply = buildAdvisorFallbackReply(message, ctx);
        return json(
          200,
          {
            ok: true,
            reply,
            source: "fallback",
            ...(bedrockDetail ? { sourceDetail: bedrockDetail } : {}),
          },
          hdrs,
          skipCors,
        );
      }

      case "POST /import/csv": {
        const subRow = await loadUserSubscriptionRowFull(pool, userId);
        const csvFeature = await evaluateFeatureForUser(pool, userId, "export_csv", subRow);
        if (!csvFeature?.allowed) {
          return json(
            403,
            {
              error: "FeatureNotAllowed",
              detail: "CSV取込はプレミアム限定機能です。",
              feature: "export_csv",
            },
            hdrs,
            skipCors,
          );
        }
        const b = JSON.parse(req.body || "{}");
        const csvSubRej = rejectNonAdminSubscriptionBodyFields(b, hdrs, skipCors);
        if (csvSubRej) return csvSubRej;
        const text = String(b.csvText || "");
        const lines = text.split(/\r?\n/).filter((l) => l.trim());
        /** @type {Array<{ dateStr: string; categoryRaw: string; amount: number; memoVal: string | null; isMedicalExpense: boolean; medicalType: ("treatment"|"medicine"|"other"|null); medicalPatientName: string | null }>} */
        const validRows = [];
        for (const line of lines) {
          const parts = line.split(/[,，\t]/).map((s) => s.trim());
          if (parts.length < 3) continue;
          const categoryRaw = parts[0];
          const dateStr = parts[1].replace(/\//g, "-");
          const amount = Number.parseFloat(parts[2].replace(/[,円]/g, ""));
          if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || !Number.isFinite(amount)) {
            continue;
          }
          let memo = parts.slice(3).join(" ").trim();
          if (memo.length > 500) memo = memo.slice(0, 500);
          const memoVal = memo || null;
          const medical = inferMedicalByText(memoVal, categoryRaw);
          validRows.push({
            dateStr,
            categoryRaw,
            amount: Math.abs(amount),
            memoVal,
            isMedicalExpense: medical.isMedicalExpense,
            medicalType: medical.medicalType,
            medicalPatientName: medical.medicalPatientName,
          });
        }
        if (validRows.length === 0) {
          return json(
            200,
            {
              ok: true,
              deleted: 0,
              inserted: 0,
              categoriesCreated: 0,
              message:
                "有効な行がありません。カテゴリ,日付,金額（YYYY-MM-DD）の形式を確認してください。",
            },
            hdrs,
            skipCors,
          );
        }
        const ymSet = new Set();
        for (const r of validRows) {
          ymSet.add(r.dateStr.slice(0, 7));
        }
        /** @type {Array<{ from: string; to: string }>} */
        const monthRanges = [];
        for (const ym of [...ymSet].sort()) {
          const bounds = ymBounds(ym);
          if (bounds) monthRanges.push(bounds);
        }
        if (monthRanges.length === 0) {
          return json(
            500,
            {
              error: "CsvImportError",
              detail: "CSV の日付から年月を解釈できませんでした。",
            },
            hdrs,
            skipCors,
          );
        }
        const monthOr = monthRanges
          .map(() => "(t.transaction_date >= ? AND t.transaction_date <= ?)")
          .join(" OR ");
        const delParams = [...txP2];
        for (const { from, to } of monthRanges) {
          delParams.push(from, to);
        }
        const [delRes] = await pool.query(
          `DELETE FROM transactions t
           WHERE ${txWhere}
           AND t.kind = 'expense'
           AND (${monthOr})`,
          delParams,
        );
        const deleted =
          delRes && typeof delRes.affectedRows === "number"
            ? delRes.affectedRows
            : 0;
        let inserted = 0;
        let categoriesCreated = 0;
        /** @type {Map<string, number>} */
        const csvCategoryByNorm = new Map();
        for (const row of validRows) {
          const rawCat = String(row.categoryRaw ?? "").trim();
          const skipLedgerFixedName = rawCat === RESERVED_LEDGER_FIXED_COST_CATEGORY;
          const { categoryId, created } = skipLedgerFixedName
            ? { categoryId: null, created: false }
            : await findOrCreateExpenseCategoryByName(
                pool,
                userId,
                familyId,
                catWhere,
                row.categoryRaw,
                csvCategoryByNorm,
              );
          if (created) categoriesCreated += 1;
          await pool.query(
            `INSERT INTO transactions (
               user_id, family_id, kind, amount, transaction_date, memo, category_id,
               is_medical_expense, medical_type, medical_patient_name
             )
             VALUES (?, ?, 'expense', ?, ?, ?, ?, ?, ?, ?)`,
            [
              userId,
              familyId,
              row.amount,
              row.dateStr,
              row.memoVal,
              categoryId,
              row.isMedicalExpense ? 1 : 0,
              row.medicalType,
              row.medicalPatientName,
            ],
          );
          inserted += 1;
        }
        return json(
          200,
          {
            ok: true,
            deleted,
            inserted,
            categoriesCreated,
            message:
              "CSV の行に現れる年月（YYYY-MM）ごとに、その月の既存の支出を削除してから行を追加しました。カテゴリ列が空なら未分類、未登録名は支出カテゴリとして自動追加します。収入は削除しません。",
          },
          hdrs,
          skipCors,
        );
      }

      case "POST /import/paypay-csv/preview":
      case "POST /import/paypay-csv/commit": {
        let b;
        try {
          b = JSON.parse(req.body || "{}");
        } catch {
          return json(
            400,
            {
              error: "InvalidRequest",
              detail: "JSON の形式が不正です。",
            },
            hdrs,
            skipCors,
          );
        }
        const text = String(b.csvText ?? "");
        const combineSameTimePayments = b.combineSameTimePayments === true;
        const combineSmallSameDayPayments = b.combineSmallSameDayPayments === true;
        const dryRun = routeKey(method, path) === "POST /import/paypay-csv/preview";
        const importResult = await executePayPayCsvImport(pool, {
          userId,
          familyId,
          csvText: text,
          combineSameTimePayments,
          combineSmallSameDayPayments,
          dryRun,
        });
        if (!importResult.ok) {
          try {
            await writePayPayMonitorLog(pool, {
              userId,
              actionType: dryRun ? "preview" : "commit",
              totalRows: importResult.counts?.totalRows ?? 0,
              newCount: 0,
              updatedCount: 0,
              aggregatedCount: importResult.counts?.aggregatedCount ?? 0,
              excludedCount: importResult.counts?.excludedCount ?? 0,
              errorCount: importResult.counts?.errorCount ?? 1,
              detail: {
                combineSameTimePayments,
                combineSmallSameDayPayments,
                error: importResult.detail || importResult.error || "PayPayCsvParseError",
                parseErrors: importResult.parseErrors || [],
              },
            });
          } catch (e) {
            logError("import.paypay.monitor_log.error", e, { userId, dryRun });
          }
          return json(
            importResult.statusCode || 400,
            {
              error: importResult.error || "PayPayImportError",
              detail: importResult.detail || "PayPay CSV の解析に失敗しました。",
              ...importResult.counts,
              parseErrors: importResult.parseErrors || [],
            },
            hdrs,
            skipCors,
          );
        }
        const monitorRow = {
          userId,
          actionType: dryRun ? "preview" : "commit",
          totalRows: importResult.counts.totalRows,
          newCount: importResult.counts.newCount,
          updatedCount: importResult.counts.updatedCount,
          aggregatedCount: importResult.counts.aggregatedCount,
          excludedCount: importResult.counts.excludedCount,
          errorCount: importResult.counts.errorCount,
          detail: {
            combineSameTimePayments,
            combineSmallSameDayPayments,
            parseErrors: importResult.parseErrors || [],
          },
        };
        try {
          await writePayPayMonitorLog(pool, monitorRow);
        } catch (e) {
          logError("import.paypay.monitor_log", e, { userId, dryRun });
        }
        return json(
          200,
          {
            ok: true,
            dryRun,
            combineSameTimePayments,
            combineSmallSameDayPayments,
            ...importResult.counts,
            parseErrors: importResult.parseErrors || [],
          },
          hdrs,
          skipCors,
        );
      }

      case "GET /admin/monitor-logs/paypay-summary": {
        const admin = await ensureAdmin(pool, userId);
        if (!admin.ok) return json(admin.status, admin.body, hdrs, skipCors);
        try {
          const [rows] = await pool.query(
            `SELECT
               ml.user_id,
               MAX(ml.created_at) AS last_import_at,
               COUNT(*) AS run_count,
               COALESCE(SUM(ml.total_rows), 0) AS total_rows,
               COALESCE(SUM(ml.new_count), 0) AS new_count,
               COALESCE(SUM(ml.updated_count), 0) AS updated_count,
               COALESCE(SUM(ml.aggregated_count), 0) AS aggregated_count,
               COALESCE(SUM(ml.excluded_count), 0) AS excluded_count,
               COALESCE(SUM(ml.error_count), 0) AS error_count,
               MAX(CASE WHEN ml.action_type = 'commit' THEN ml.created_at ELSE NULL END) AS last_commit_at,
               MAX(CASE WHEN ml.action_type = 'preview' THEN ml.created_at ELSE NULL END) AS last_preview_at,
               MAX(u.email) AS user_email
             FROM monitor_logs ml
             LEFT JOIN users u ON u.id = ml.user_id
             WHERE ml.log_type = 'paypay_import'
             GROUP BY ml.user_id
             ORDER BY last_import_at DESC`,
          );
          return json(200, { items: rows }, hdrs, skipCors);
        } catch (e) {
          logError("admin.monitor_logs.paypay_summary", e, { userId });
          return json(
            500,
            {
              error: "MonitorLogsReadError",
              detail:
                "monitor_logs の取得に失敗しました。db/migration_v24_paypay_import.sql の適用を確認してください。",
            },
            hdrs,
            skipCors,
          );
        }
      }

      case "GET /admin/payments/monthly-summary": {
        const admin = await ensureAdmin(pool, userId);
        if (!admin.ok) return json(admin.status, admin.body, hdrs, skipCors);
        try {
          const [rows] = await pool.query(
            `SELECT
               DATE_FORMAT(occurred_at, '%Y-%m') AS ym,
               COALESCE(SUM(gross_amount), 0) AS gross_total,
               COALESCE(SUM(
                 CASE
                   WHEN gross_amount > 0.0001
                    AND (stripe_fee_amount IS NULL OR ABS(COALESCE(stripe_fee_amount, 0)) < 0.0001)
                    AND (
                      (gross_amount - COALESCE(net_amount, gross_amount)) > 0.0001
                      AND (gross_amount - COALESCE(net_amount, gross_amount)) < (gross_amount * 0.5)
                    )
                   THEN (gross_amount - COALESCE(net_amount, 0))
                   WHEN gross_amount > 0.0001
                    AND (stripe_fee_amount IS NULL OR ABS(COALESCE(stripe_fee_amount, 0)) < 0.0001)
                   THEN ROUND(gross_amount * 0.036, 0)
                   ELSE COALESCE(stripe_fee_amount, 0)
                 END
               ), 0) AS fee_total,
               COALESCE(SUM(
                 CASE
                   WHEN gross_amount > 0.0001
                    AND (stripe_fee_amount IS NULL OR ABS(COALESCE(stripe_fee_amount, 0)) < 0.0001)
                    AND (
                      (gross_amount - COALESCE(net_amount, gross_amount)) > 0.0001
                      AND (gross_amount - COALESCE(net_amount, gross_amount)) < (gross_amount * 0.5)
                    )
                   THEN COALESCE(net_amount, 0)
                   WHEN gross_amount > 0.0001
                    AND (stripe_fee_amount IS NULL OR ABS(COALESCE(stripe_fee_amount, 0)) < 0.0001)
                   THEN (gross_amount - ROUND(gross_amount * 0.036, 0))
                   ELSE COALESCE(net_amount, 0)
                 END
               ), 0) AS net_total,
               COUNT(*) AS sales_count
             FROM sales_logs
             GROUP BY DATE_FORMAT(occurred_at, '%Y-%m')
             ORDER BY ym DESC
             LIMIT 24`,
          );
          return json(200, { items: rows }, hdrs, skipCors);
        } catch (e) {
          logError("admin.payments.monthly_summary", e, { userId });
          const code = String(e?.code || "");
          if (code === "ER_NO_SUCH_TABLE") {
            return json(
              503,
              {
                error: "SalesLogsUnavailable",
                detail:
                  "sales_logs テーブルがありません。db/migration_v37_sales_logs.sql を適用してください。",
              },
              hdrs,
              skipCors,
            );
          }
          return json(500, { error: "SalesSummaryReadError" }, hdrs, skipCors);
        }
      }

      case "GET /admin/payments/daily-summary": {
        const admin = await ensureAdmin(pool, userId);
        if (!admin.ok) return json(admin.status, admin.body, hdrs, skipCors);
        const from = String(q.from ?? "").trim();
        const to = String(q.to ?? "").trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
          return json(
            400,
            { error: "InvalidRequest", detail: "from と to（YYYY-MM-DD）が必要です" },
            hdrs,
            skipCors,
          );
        }
        if (from > to) {
          return json(400, { error: "InvalidRequest", detail: "from <= to である必要があります" }, hdrs, skipCors);
        }
        const startMs = Date.parse(`${from}T00:00:00+09:00`);
        const endMs = Date.parse(`${to}T00:00:00+09:00`);
        const daySpan = Math.floor((endMs - startMs) / 86400000) + 1;
        if (daySpan > 400) {
          return json(
            400,
            { error: "RangeTooLarge", detail: "日付範囲は 400 日以内にしてください" },
            hdrs,
            skipCors,
          );
        }
        try {
          const [rows] = await pool.query(
            `SELECT
               DATE_FORMAT(occurred_at, '%Y-%m-%d') AS day_key,
               COALESCE(SUM(gross_amount), 0) AS gross_total,
               COALESCE(SUM(
                 CASE
                   WHEN gross_amount > 0.0001
                    AND (stripe_fee_amount IS NULL OR ABS(COALESCE(stripe_fee_amount, 0)) < 0.0001)
                    AND (
                      (gross_amount - COALESCE(net_amount, gross_amount)) > 0.0001
                      AND (gross_amount - COALESCE(net_amount, gross_amount)) < (gross_amount * 0.5)
                    )
                   THEN (gross_amount - COALESCE(net_amount, 0))
                   WHEN gross_amount > 0.0001
                    AND (stripe_fee_amount IS NULL OR ABS(COALESCE(stripe_fee_amount, 0)) < 0.0001)
                   THEN ROUND(gross_amount * 0.036, 0)
                   ELSE COALESCE(stripe_fee_amount, 0)
                 END
               ), 0) AS fee_total,
               COALESCE(SUM(
                 CASE
                   WHEN gross_amount > 0.0001
                    AND (stripe_fee_amount IS NULL OR ABS(COALESCE(stripe_fee_amount, 0)) < 0.0001)
                    AND (
                      (gross_amount - COALESCE(net_amount, gross_amount)) > 0.0001
                      AND (gross_amount - COALESCE(net_amount, gross_amount)) < (gross_amount * 0.5)
                    )
                   THEN COALESCE(net_amount, 0)
                   WHEN gross_amount > 0.0001
                    AND (stripe_fee_amount IS NULL OR ABS(COALESCE(stripe_fee_amount, 0)) < 0.0001)
                   THEN (gross_amount - ROUND(gross_amount * 0.036, 0))
                   ELSE COALESCE(net_amount, 0)
                 END
               ), 0) AS net_total,
               COUNT(*) AS sales_count
             FROM sales_logs
             WHERE DATE(occurred_at) >= ? AND DATE(occurred_at) <= ?
             GROUP BY DATE(occurred_at)
             ORDER BY day_key ASC`,
            [from, to],
          );
          return json(200, { items: rows, from, to }, hdrs, skipCors);
        } catch (e) {
          logError("admin.payments.daily_summary", e, { userId });
          const code = String(e?.code || "");
          if (code === "ER_NO_SUCH_TABLE") {
            return json(
              503,
              {
                error: "SalesLogsUnavailable",
                detail:
                  "sales_logs テーブルがありません。db/migration_v37_sales_logs.sql を適用してください。",
              },
              hdrs,
              skipCors,
            );
          }
          return json(500, { error: "SalesDailyReadError" }, hdrs, skipCors);
        }
      }

      case "GET /admin/payments/sales-logs": {
        const admin = await ensureAdmin(pool, userId);
        if (!admin.ok) return json(admin.status, admin.body, hdrs, skipCors);
        const ym = String(q.ym ?? "").trim();
        const from = String(q.from ?? "").trim();
        const to = String(q.to ?? "").trim();
        const where = [];
        const params = [];
        if (/^\d{4}-\d{2}$/.test(ym)) {
          where.push("DATE_FORMAT(sl.occurred_at, '%Y-%m') = ?");
          params.push(ym);
        }
        if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
          where.push("DATE(sl.occurred_at) >= ?");
          params.push(from);
        }
        if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
          where.push("DATE(sl.occurred_at) <= ?");
          params.push(to);
        }
        const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
        try {
          const [rows] = await pool.query(
            `SELECT
               sl.id,
               sl.occurred_at,
               sl.currency,
               sl.gross_amount,
               sl.stripe_fee_amount,
               sl.net_amount,
               sl.user_id,
               sl.family_id,
               u.email AS user_email,
               f.name AS family_name,
               sl.stripe_source_type,
               sl.stripe_source_id
             FROM sales_logs sl
             LEFT JOIN users u ON u.id = sl.user_id
             LEFT JOIN families f ON f.id = sl.family_id
             ${whereSql}
             ORDER BY sl.occurred_at DESC, sl.id DESC
             LIMIT 500`,
            params,
          );
          const items = Array.isArray(rows)
            ? rows.map((r) => applyEstimatedFeeToLogRowForDisplay(r))
            : rows;
          return json(200, { items }, hdrs, skipCors);
        } catch (e) {
          logError("admin.payments.sales_logs", e, { userId });
          const code = String(e?.code || "");
          if (code === "ER_NO_SUCH_TABLE") {
            return json(
              503,
              {
                error: "SalesLogsUnavailable",
                detail:
                  "sales_logs テーブルがありません。db/migration_v37_sales_logs.sql を適用してください。",
              },
              hdrs,
              skipCors,
            );
          }
          return json(500, { error: "SalesLogsReadError" }, hdrs, skipCors);
        }
      }

      case "GET /admin/payments/export.csv": {
        const admin = await ensureAdmin(pool, userId);
        if (!admin.ok) return json(admin.status, admin.body, hdrs, skipCors);
        const from = String(q.from ?? "").trim();
        const to = String(q.to ?? "").trim();
        const where = [];
        const params = [];
        if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
          where.push("DATE(sl.occurred_at) >= ?");
          params.push(from);
        }
        if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
          where.push("DATE(sl.occurred_at) <= ?");
          params.push(to);
        }
        const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
        try {
          const [rows] = await pool.query(
            `SELECT
               sl.occurred_at AS day_key,
               sl.stripe_source_type AS source_kind,
               sl.gross_amount AS gross_total,
               sl.stripe_fee_amount AS fee_total,
               sl.net_amount AS net_total,
               sl.currency,
               COALESCE(NULLIF(TRIM(u.display_name), ''), NULLIF(TRIM(u.email), ''), IFNULL(CONCAT('user#', sl.user_id), '')) AS user_name,
               sl.stripe_source_id AS stripe_payment_id
             FROM sales_logs sl
             LEFT JOIN users u ON u.id = sl.user_id
             ${whereSql}
             ORDER BY sl.occurred_at ASC, sl.id ASC`,
            params,
          );
          const mapped = (Array.isArray(rows) ? rows : []).map((r) => {
            const a = applyEstimatedFeeToLogRowForDisplay({
              ...r,
              gross_amount: r.gross_total,
              stripe_fee_amount: r.fee_total,
              net_amount: r.net_total,
            });
            return {
              day_key: r.day_key,
              source_kind: r.source_kind,
              user_name: r.user_name,
              stripe_payment_id: r.stripe_payment_id,
              gross_total: a.gross_amount,
              fee_total: a.stripe_fee_amount,
              net_total: a.net_amount,
            };
          });
          const csv = buildSalesDailyCsv(mapped);
          const cors = skipCors ? {} : buildCorsHeaders(req.headers || {});
          return {
            statusCode: 200,
            headers: {
              "content-type": "text/csv; charset=utf-8",
              "content-disposition": `attachment; filename=\"sales-report-${Date.now()}.csv\"`,
              ...cors,
            },
            body: csv,
          };
        } catch (e) {
          logError("admin.payments.export_csv", e, { userId });
          const code = String(e?.code || "");
          if (code === "ER_NO_SUCH_TABLE") {
            return json(
              503,
              {
                error: "SalesLogsUnavailable",
                detail:
                  "sales_logs テーブルがありません。db/migration_v37_sales_logs.sql を適用してください。",
              },
              hdrs,
              skipCors,
            );
          }
          return json(500, { error: "SalesCsvExportError" }, hdrs, skipCors);
        }
      }

      case "POST /receipts/learn": {
        const b = JSON.parse(req.body || "{}");
        const learnSubRej = rejectNonAdminSubscriptionBodyFields(b, hdrs, skipCors);
        if (learnSubRej) return learnSubRej;
        const summary = b.summary;
        const items = Array.isArray(b.items) ? b.items : [];
        if (summary == null || typeof summary !== "object") {
          return json(
            400,
            { error: "InvalidRequest", detail: "summary（取込データ）が必要です。" },
            hdrs,
            skipCors,
          );
        }
        const snapshot = buildReceiptOcrSnapshot(summary, items);
        const matchKey = receiptOcrMatchKey(summary, items);
        let categoryId = null;
        if (b.category_id != null && b.category_id !== "") {
          const n = Number(b.category_id);
          if (!Number.isFinite(n) || n <= 0) {
            return json(
              400,
              { error: "InvalidRequest", detail: "category_id が不正です。" },
              hdrs,
              skipCors,
            );
          }
          categoryId = n;
        }
        let memo = b.memo == null || b.memo === "" ? null : String(b.memo).trim().slice(0, 500);
        if (memo === "") memo = null;

        try {
          const [existing] = await pool.query(
            `SELECT category_id, memo FROM receipt_ocr_corrections
             WHERE user_id = ? AND match_key = ? LIMIT 1`,
            [userId, matchKey],
          );
          const ex = Array.isArray(existing) && existing[0];
          const exCat =
            ex?.category_id != null && ex.category_id !== ""
              ? Number(ex.category_id)
              : null;
          const exMemo = ex?.memo != null ? String(ex.memo) : null;
          const sameCat = (exCat ?? null) === (categoryId ?? null);
          const sameMemo = (exMemo ?? "") === (memo ?? "");
          if (ex && sameCat && sameMemo) {
            return json(200, { ok: true, skipped: true }, hdrs, skipCors);
          }

          const jsonSnap = JSON.stringify(snapshot);
          await pool.query(
            `INSERT INTO receipt_ocr_corrections
              (user_id, family_id, match_key, ocr_snapshot_json, category_id, memo)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               family_id = VALUES(family_id),
               ocr_snapshot_json = VALUES(ocr_snapshot_json),
               category_id = VALUES(category_id),
               memo = VALUES(memo),
               updated_at = CURRENT_TIMESTAMP`,
            [userId, familyId, matchKey, jsonSnap, categoryId, memo],
          );
          try {
            const ct =
              b.confirmed_total_amount != null && Number.isFinite(Number(b.confirmed_total_amount))
                ? Math.round(Number(b.confirmed_total_amount))
                : null;
            const cd =
              b.confirmed_date != null && String(b.confirmed_date).trim() !== ""
                ? String(b.confirmed_date).trim().slice(0, 10)
                : null;
            const vendorHint =
              snapshot.vendorName != null && String(snapshot.vendorName).trim() !== ""
                ? snapshot.vendorName
                : memo;
            const globalLearnSummary = buildReceiptOcrSnapshot(
              {
                vendorName: vendorHint,
                totalAmount:
                  ct != null && Number.isFinite(ct) && ct > 0 ? ct : snapshot.totalAmount,
                date:
                  cd && /^\d{4}-\d{2}-\d{2}$/.test(cd)
                    ? cd
                    : snapshot.date != null
                      ? String(snapshot.date)
                      : null,
              },
              [],
            );
            await upsertGlobalReceiptOcrStat(pool, globalLearnSummary);
          } catch (eG) {
            const gCode = eG && typeof eG === "object" && "code" in eG ? String(eG.code) : "";
            if (gCode !== "ER_NO_SUCH_TABLE") {
              logError("receipts.learn.global_agg", eG);
            }
          }
          return json(200, { ok: true, skipped: false }, hdrs, skipCors);
        } catch (e) {
          const code = e && typeof e === "object" && "code" in e ? String(e.code) : "";
          if (code === "ER_NO_SUCH_TABLE") {
            return json(
              503,
              {
                error: "ReceiptLearnUnavailable",
                detail:
                  "receipt_ocr_corrections テーブルがありません。db/migration_v5_receipt_ocr_corrections.sql を実行してください。",
              },
              hdrs,
              skipCors,
            );
          }
          logError("receipts.learn", e);
          return json(
            500,
            { error: "ReceiptLearnError", detail: "補正データの保存に失敗しました。" },
            hdrs,
            skipCors,
          );
        }
      }

      case "POST /receipts/upload": {
        const b = JSON.parse(req.body || "{}");
        const subRejU = rejectNonAdminSubscriptionBodyFields(b, hdrs, skipCors);
        if (subRejU) return subRejU;
        if (b.imageBase64 == null || typeof b.imageBase64 !== "string") {
          return json(
            400,
            {
              error: "InvalidRequest",
              detail: "imageBase64（JPEG/PNG 等の base64、または data URL）が必要です。",
            },
            hdrs,
            skipCors,
          );
        }
        const jobId = crypto.randomUUID();
        const requestPayload = { imageBase64: b.imageBase64 };
        if (b.debugForceReceiptTier != null) {
          requestPayload.debugForceReceiptTier = b.debugForceReceiptTier;
        }
        const requestJson = JSON.stringify(requestPayload);
        try {
          await pool.query(
            `INSERT INTO receipt_processing_jobs (job_id, user_id, status, request_json)
             VALUES (?, ?, 'pending', ?)`,
            [jobId, userId, requestJson],
          );
        } catch (e) {
          if (e && typeof e === "object" && e.code === "ER_NO_SUCH_TABLE") {
            return json(
              503,
              {
                error: "ReceiptJobUnavailable",
                detail:
                  "receipt_processing_jobs がありません。db/migration_v43_receipt_processing_jobs.sql を実行してください。",
              },
              hdrs,
              skipCors,
            );
          }
          logError("receipts.upload.insert_job", e);
          return json(500, { error: "JobEnqueueError", detail: "ジョブの受付に失敗しました" }, hdrs, skipCors);
        }
        const fwd = pickAuthHeadersForInternalParse(hdrs);
        setImmediate(() => {
          void runReceiptJobAfterUpload(pool, jobId, userId, fwd);
        });
        return json(202, { ok: true, jobId, status: "pending" }, hdrs, skipCors);
      }

      case "POST /receipts/parse": {
        const b = JSON.parse(req.body || "{}");
        const subRej = rejectNonAdminSubscriptionBodyFields(b, hdrs, skipCors);
        if (subRej) return subRej;
        if (b.imageBase64 == null || typeof b.imageBase64 !== "string") {
          return json(
            400,
            {
              error: "InvalidRequest",
              detail:
                "imageBase64（JPEG/PNG 等の base64、または data URL）が必要です。",
            },
            hdrs,
            skipCors,
          );
        }
        try {
          const buf = decodeImageBuffer(b.imageBase64);
          const result = await analyzeReceiptImageBytes(buf, { logError });
          const [expenseCats] = await pool.query(
            `SELECT c.id, c.name
             FROM categories c
             WHERE ${catWhere} AND c.is_archived = 0 AND c.kind = 'expense'
             ORDER BY c.sort_order, c.id`,
            [userId, userId],
          );
          const expenseCatRows = Array.isArray(expenseCats) ? expenseCats : [];
          let memoCategoryPairs = [];
          try {
            memoCategoryPairs = await fetchTopMemoCategoryPairs(pool, userId, txWhere, txP2, 40);
          } catch (eMc) {
            logError("receipts.parse.memo_category_pairs", eMc);
          }
          const subRow = await loadUserSubscriptionRowFull(pool, userId);
          let subscriptionActive = userHasPremiumSubscriptionAccess(subRow, userId);
          let debugReceiptTierOverride = null;
          if (isReceiptSubscriptionDebugAllowed()) {
            const raw =
              b.debugForceReceiptTier != null
                ? String(b.debugForceReceiptTier).trim().toLowerCase()
                : "";
            if (raw === "free" || raw === "subscribed") {
              debugReceiptTierOverride = raw;
              subscriptionActive = raw === "subscribed";
            }
          }
          try {
            const derivedSt = deriveSubscriptionStatusFromDbRow(subRow);
            logger.info(
              JSON.stringify({
                event: "receipts.parse.subscription_gate",
                userId,
                subscriptionActive,
                debugReceiptTierOverride,
                derivedSubscriptionStatus: derivedSt,
                dbSubscriptionStatus: subRow?.subscription_status ?? null,
                receiptMode: subscriptionActive ? "premium_ai" : "standard",
              }),
            );
          } catch {
            /* ignore log serialization */
          }
          const expenseCategoryIdNameRows = expenseCatRows.map((c) => ({
            id: Number(c.id),
            name: String(c.name),
          }));
          const textractVendorBaseline = String(result?.summary?.vendorName ?? "").trim();
          const suggestedCategory = await suggestExpenseCategoryForReceipt(
            pool,
            userId,
            catWhere,
            txWhere,
            result?.summary?.vendorName ?? "",
            result?.items ?? [],
            { usePersonalHistory: true, expenseCategories: expenseCatRows, txWhereParams: txP2 },
          );
          const historyHints = subscriptionActive
            ? await fetchReceiptSubscriptionHistoryHints(pool, userId, txWhere, 48, txP2)
            : [];
          let vendorOcrKeyHints = [];
          if (subscriptionActive) {
            try {
              vendorOcrKeyHints = await fetchUserVendorOcrKeyCategoryHints(pool, userId);
            } catch (eH) {
              logError("receipts.parse.vendor_ocr_key_hints", eH);
            }
          }
          const hybridTextractPayload = {
            summary: result?.summary ?? {},
            items: result?.items ?? [],
            ocrLines: result?.ocrLines ?? [],
            textractRaw: result?.textractRaw ?? {},
          };
          const [hybridReceipt, aiReceipt] = await Promise.all([
            (async () => {
              try {
                return await askBedrockHybridReceiptFromTextract({
                  textract: hybridTextractPayload,
                  categoryCandidates: expenseCategoryIdNameRows,
                  memoCategoryPairs,
                });
              } catch (e) {
                logError("receipts.parse.hybrid_ocr", e);
                return null;
              }
            })(),
            (async () => {
              if (!subscriptionActive) return null;
              try {
                return await askBedrockReceiptAssistant({
                  subscriptionActive,
                  historyHints,
                  memoCategoryPairs,
                  vendorOcrKeyHints,
                  heuristicCategorySuggestion: suggestedCategory
                    ? {
                        name: suggestedCategory.name,
                        source: suggestedCategory.source,
                      }
                    : null,
                  summary: result?.summary ?? {},
                  items: result?.items ?? [],
                  ocrLines: result?.ocrLines ?? [],
                  categoryCandidates: expenseCategoryIdNameRows,
                  imageBase64: buf.toString("base64"),
                  imageMediaType: inferReceiptImageMediaTypeFromBuffer(buf),
                });
              } catch (e) {
                logError("receipts.parse.ai_assist", e);
                return null;
              }
            })(),
          ]);

          let adjustedSummary = { ...(result?.summary ?? {}) };
          let receiptAiLineItems = null;
          if (hybridReceipt?.ok && hybridReceipt.data) {
            const hs = hybridReceipt.data;
            if (hs.storeName && String(hs.storeName).trim()) {
              adjustedSummary.vendorName = String(hs.storeName).trim().slice(0, 120);
            }
            if (hs.date && /^\d{4}-\d{2}-\d{2}$/.test(String(hs.date))) {
              adjustedSummary.date = String(hs.date);
            }
            if (Number.isFinite(Number(hs.totalAmount)) && Number(hs.totalAmount) > 0) {
              adjustedSummary.totalAmount = Math.round(Number(hs.totalAmount));
            }
            if (Number.isFinite(Number(hs.taxAmount)) && Number(hs.taxAmount) >= 0) {
              adjustedSummary.taxAmount = Math.round(Number(hs.taxAmount));
            }
            if (Array.isArray(hs.items) && hs.items.length > 0) {
              const hasTextractAmounts = Array.isArray(result?.items)
                ? result.items.some((x) => Number.isFinite(Number(x?.amount ?? NaN)) && Number(x?.amount ?? NaN) > 0)
                : false;
              if (!hasTextractAmounts) {
                result.items = hs.items.map((x, idx) => ({
                  name: String(x?.name ?? "（品目）").trim() || `（品目${idx + 1}）`,
                  amount:
                    Number.isFinite(Number(x?.unitPrice ?? NaN)) && Number(x?.unitPrice ?? NaN) >= 0
                      ? Math.round(Number(x.unitPrice))
                      : null,
                  category: String(x?.category ?? "").trim() || "その他",
                  confidence: null,
                }));
              }
            }
          }
          if (Array.isArray(result?.items)) {
            result.items = result.items.map((x) => ({
              ...x,
              category: String(x?.category ?? "").trim() || "その他",
            }));
          }
          let aiCategoryId = null;
          let aiCategoryName = null;
          if (aiReceipt?.ok && aiReceipt.data) {
            const d = aiReceipt.data;
            const aiVendor = String(d.vendorName ?? "").trim();
            const aiDate = String(d.date ?? "").trim();
            const aiTotal = Number(d.totalAmount ?? NaN);
            const aiCat = String(d.categoryName ?? "").trim();
            if (
              subscriptionActive &&
              aiVendor &&
              (!adjustedSummary.vendorName ||
                String(adjustedSummary.vendorName).trim().length < 2 ||
                /^(不明|unknown|不詳)$/i.test(String(adjustedSummary.vendorName).trim()))
            ) {
              adjustedSummary.vendorName = aiVendor.slice(0, 120);
            }
            if (aiDate && /^\d{4}-\d{2}-\d{2}$/.test(aiDate) && !adjustedSummary.date) {
              adjustedSummary.date = aiDate;
            }
            if (Number.isFinite(aiTotal) && aiTotal > 0) {
              const current = Number(adjustedSummary.totalAmount ?? NaN);
              if (!Number.isFinite(current) || current <= 0 || aiTotal > current * 1.15) {
                adjustedSummary.totalAmount = Math.round(aiTotal);
              }
            }
            if (Number.isFinite(Number(d.taxAmount)) && Number(d.taxAmount) >= 0) {
              adjustedSummary.taxAmount = Math.round(Number(d.taxAmount));
            }
            if (Array.isArray(d.lineItems) && d.lineItems.length > 0) {
              receiptAiLineItems = d.lineItems.slice(0, 80);
            }
            if (subscriptionActive && aiCat) {
              aiCategoryId = pickCategoryIdByAiName(aiCat, expenseCatRows);
              if (aiCategoryId != null) {
                const hit = expenseCatRows.find((x) => Number(x.id) === Number(aiCategoryId));
                aiCategoryName = hit?.name ? String(hit.name) : aiCat;
              }
            }
            if (
              subscriptionActive &&
              aiReceipt.receiptAiSource === "vision" &&
              (d.vendorName == null || String(d.vendorName).trim() === "")
            ) {
              const cur = String(adjustedSummary.vendorName ?? "").trim();
              if (
                !cur ||
                cur.length < 2 ||
                /^(不明|unknown|不詳)$/i.test(cur) ||
                /^[-_/|\s・。]+$/.test(cur)
              ) {
                adjustedSummary.vendorName = null;
              }
            }
          }

          let suggestedVendor = null;
          if (subscriptionActive && String(adjustedSummary?.vendorName ?? "").trim().length >= 2) {
            try {
              const cached = await getUserStorePlaceCached(
                pool,
                userId,
                String(adjustedSummary.vendorName).trim(),
              );
              if (cached) {
                suggestedVendor = {
                  fromCache: true,
                  placeId: cached.placeId,
                  suggestedStoreName: cached.suggestedStoreName,
                  locationHint: cached.locationHint,
                  preferredCategoryId: cached.preferredCategoryId,
                  ocrVendorKey: cached.ocrVendorKey,
                  inferenceConfidence: 1,
                  inferenceLowConfidence: false,
                };
              } else {
                const vn = String(adjustedSummary.vendorName).trim();
                suggestedVendor = {
                  deferred: true,
                  ocrVendorKey: ocrVendorFingerprintHex(vn),
                  rawVendorName: vn.slice(0, 200),
                };
              }
            } catch (ePl) {
              logError("receipts.parse.suggested_vendor", ePl);
            }
          }

          let learnCorrectionHit = false;
          let learnedCategoryId = null;
          let learnedCategoryName = null;
          let learnedMemoPresent = false;
          let learnedMemoValue = "";
          let learnedMode = null;
          if (subscriptionActive) {
            try {
              const learned = await findLearnedReceiptCorrection(
                pool,
                userId,
                catWhere,
                result?.summary,
                result?.items ?? [],
              );
              if (learned?.hit) {
                const hasCat = learned.categoryId != null;
                const hasMemo = learned.memoPresent;
                if (hasCat || hasMemo) {
                  learnCorrectionHit = true;
                  learnedMode = learned.mode;
                  if (hasCat) {
                    learnedCategoryId = Number(learned.categoryId);
                    const [cn] = await pool.query(
                      `SELECT c.name FROM categories c
                       WHERE ${catWhere} AND c.id = ? AND c.is_archived = 0 LIMIT 1`,
                      [userId, userId, learnedCategoryId],
                    );
                    if (Array.isArray(cn) && cn[0]?.name) {
                      learnedCategoryName = String(cn[0].name);
                    }
                  }
                  if (hasMemo) {
                    learnedMemoPresent = true;
                    learnedMemoValue = learned.memoValue;
                  }
                }
              }
            } catch (e) {
              const code = e && typeof e === "object" && "code" in e ? String(e.code) : "";
              if (code !== "ER_NO_SUCH_TABLE") {
                logError("receipts.parse.correction_lookup", e);
              }
            }
          }

          let reconcileAdjusted = false;
          let reconcilePremiumNote = null;
          if (subscriptionActive) {
            const rec = reconcilePremiumReceiptTotal(adjustedSummary, result?.items ?? []);
            if (rec.adjusted) {
              adjustedSummary = rec.summary;
              reconcileAdjusted = true;
              reconcilePremiumNote = rec.note;
            }
          }

          const receiptAdvancedParsingMessages = [];
          if (subscriptionActive) {
            if (learnCorrectionHit && (learnedCategoryId != null || learnedMemoPresent)) {
              receiptAdvancedParsingMessages.push(
                "過去に保存した修正パターンに基づき、カテゴリやメモを提案しました。",
              );
            }
            if (hybridReceipt?.ok) {
              receiptAdvancedParsingMessages.push(
                "Textract抽出結果をBedrockで補正し、店名・日付・合計・明細の推定を強化しました。",
              );
            }
            if (reconcileAdjusted && reconcilePremiumNote) {
              receiptAdvancedParsingMessages.push(reconcilePremiumNote);
            }
            const vNow = String(adjustedSummary?.vendorName ?? "").trim();
            if (
              vNow &&
              receiptVendorSignalWeak(textractVendorBaseline) &&
              ocrLinesMayContainJapanPhone(result?.ocrLines)
            ) {
              receiptAdvancedParsingMessages.push(
                `電話番号などの表記を手がかりに、店舗名を「${vNow.slice(0, 80)}」として補完しました。`,
              );
            }
            while (receiptAdvancedParsingMessages.length > 5) {
              receiptAdvancedParsingMessages.pop();
            }
            for (let i = 0; i < receiptAdvancedParsingMessages.length; i += 1) {
              receiptAdvancedParsingMessages[i] = String(receiptAdvancedParsingMessages[i]).slice(
                0,
                220,
              );
            }
          }

          const predicted = await predictCategory({
            pool,
            userId,
            familyId,
            txWhere,
            txWhereParams: txP2,
            vendor: adjustedSummary?.vendorName ?? result?.summary?.vendorName ?? "",
            items: result?.items ?? [],
            userExpenseCategories: expenseCatRows,
            subscriptionActive,
            aiCategoryName,
          });
          let placePreferredCategoryId = null;
          let placePreferredCategoryName = null;
          if (
            suggestedVendor &&
            !suggestedVendor.deferred &&
            suggestedVendor.preferredCategoryId != null
          ) {
            const ppn = Number(suggestedVendor.preferredCategoryId);
            if (Number.isFinite(ppn) && ppn > 0) {
              const pHit = expenseCatRows.find((x) => Number(x.id) === ppn);
              if (pHit) {
                placePreferredCategoryId = ppn;
                placePreferredCategoryName = String(pHit.name);
              }
            }
          }
          /* 個別辞書 > 店名キー学習 > 予測/AI */
          const finalSuggestedId =
            learnedCategoryId != null
              ? learnedCategoryId
              : placePreferredCategoryId != null
                ? placePreferredCategoryId
                : predicted.id != null
                  ? predicted.id
                  : null;
          const finalSuggestedName =
            learnedCategoryId != null
              ? learnedCategoryName
              : placePreferredCategoryId != null
                ? placePreferredCategoryName
                : predicted.name != null
                  ? predicted.name
                  : null;
          const finalSource =
            learnCorrectionHit && (learnedCategoryId != null || learnedMemoPresent)
              ? "correction"
              : placePreferredCategoryId != null
                ? "vendor_key_learn"
                : predicted.source;
          const suggestedCategoryLowConfidence =
            learnedCategoryId != null || placePreferredCategoryId != null
              ? false
              : Boolean(predicted.lowConfidence);

          let duplicateWarning = null;
          try {
            const ymd = normalizeReceiptDateForSql(adjustedSummary?.date);
            const tot = Number(adjustedSummary?.totalAmount ?? NaN);
            const memoForDup =
              learnCorrectionHit && learnedMemoPresent
                ? normalizeTxMemo(learnedMemoValue)
                : normalizeTxMemo(adjustedSummary?.vendorName);
            if (ymd && Number.isFinite(tot) && tot > 0) {
              const [exRows] = await pool.query(
                `SELECT t.id FROM transactions t
                 WHERE t.user_id = ?
                   AND t.kind = 'expense'
                   AND t.transaction_date = ?
                   AND t.amount = ?
                   AND (t.memo <=> ?)
                 LIMIT 1`,
                [userId, ymd, tot, memoForDup],
              );
              if (Array.isArray(exRows) && exRows.length > 0) {
                duplicateWarning =
                  "既に登録済です（同じお店・日付・金額の取引が登録されています）";
              }
            }
          } catch (eDup) {
            logError("receipts.parse.duplicate_check", eDup);
          }

          let totalCandidates = [];
          let receiptGlobalDictionaryHitCount = 0;
          if (subscriptionActive) {
            try {
              const fpSummary = mergeSummaryForGlobalFingerprint(
                result?.summary ?? {},
                adjustedSummary,
              );
              const globalHit = await fetchGlobalReceiptTotalsBySummaryWindow(pool, fpSummary, 8);
              const globalRows = globalHit.rows;
              receiptGlobalDictionaryHitCount = globalHit.hitCount;
              totalCandidates = buildReceiptTotalCandidates({
                subscriptionActive,
                adjustedSummary,
                items: result.items ?? [],
                globalRows,
              });
            } catch (eGlob) {
              const gCode =
                eGlob && typeof eGlob === "object" && "code" in eGlob ? String(eGlob.code) : "";
              if (gCode !== "ER_NO_SUCH_TABLE") {
                logError("receipts.parse.global_agg", eGlob);
              }
              totalCandidates = buildReceiptTotalCandidates({
                subscriptionActive,
                adjustedSummary,
                items: result.items ?? [],
                globalRows: [],
              });
            }
          }
          if (
            subscriptionActive &&
            totalCandidates.some((c) => c.source === "global") &&
            !receiptAdvancedParsingMessages.some((m) => String(m).includes("匿名"))
          ) {
            receiptAdvancedParsingMessages.push(
              "匿名化された利用傾向から、合計金額の別候補を表示しています。",
            );
            while (receiptAdvancedParsingMessages.length > 5) {
              receiptAdvancedParsingMessages.shift();
            }
            for (let mi = 0; mi < receiptAdvancedParsingMessages.length; mi += 1) {
              receiptAdvancedParsingMessages[mi] = String(receiptAdvancedParsingMessages[mi]).slice(
                0,
                220,
              );
            }
          }

          const receiptAdvancedParsingApplied =
            Boolean(subscriptionActive) &&
            (Boolean(aiReceipt?.ok) ||
              Boolean(hybridReceipt?.ok) ||
              learnCorrectionHit ||
              reconcileAdjusted ||
              finalSource === "history" ||
              finalSource === "chain_catalog" ||
              finalSource === "global_master" ||
              finalSource === "line_items" ||
              totalCandidates.some((c) => c.source === "global"));
          const body = {
            ok: true,
            demo: false,
            summary: adjustedSummary,
            items: result.items,
            mainCategory: String(hybridReceipt?.data?.mainCategory ?? "").trim() || null,
            notice: result.notice,
            expenseIndex: result.expenseIndex,
            learnCorrectionHit,
            suggestedCategoryId: finalSuggestedId,
            suggestedCategoryName: finalSuggestedName ?? null,
            suggestedCategorySource: finalSource,
            suggestedCategoryLowConfidence,
            suggestedCategoryCorrectionMode: learnedMode,
            subscriptionActive,
            receiptAiTier: aiReceipt?.receiptAiTier ?? null,
            debugReceiptTierOverride,
            subscriptionMockedByEnv: isUserIdForcedPremiumByEnv(userId),
            receiptAdvancedParsingApplied,
            receiptAdvancedParsingBanner: receiptAdvancedParsingApplied
              ? "高度な解析を適用しました"
              : null,
            receiptAdvancedParsingMessages,
            totalCandidates,
            receiptGlobalDictionaryHitCount: subscriptionActive ? receiptGlobalDictionaryHitCount : 0,
            suggestedVendor,
            receiptAiDetail: subscriptionActive
              ? {
                  taxAmount:
                    adjustedSummary.taxAmount != null &&
                    Number.isFinite(Number(adjustedSummary.taxAmount))
                      ? Math.round(Number(adjustedSummary.taxAmount))
                      : null,
                  lineItems: receiptAiLineItems,
                }
              : null,
          };
          if (learnCorrectionHit && learnedMemoPresent) {
            body.suggestedMemo = learnedMemoValue;
          }
          if (duplicateWarning) {
            body.duplicateWarning = duplicateWarning;
          }
          return json(200, body, hdrs, skipCors);
        } catch (e) {
          const status =
            e &&
            typeof e === "object" &&
            "statusCode" in e &&
            Number.isFinite(Number(e.statusCode))
              ? Number(e.statusCode)
              : 500;
          const code =
            e && typeof e === "object" && "code" in e && e.code
              ? String(e.code)
              : "ReceiptParseError";
          logError("receipts.parse", e, { code, status });
          // Textract の一時障害時は手入力フローを継続できるよう 200 で返す。
          if (
            code === "TextractTimeout" ||
            code === "TextractNetworkBusy" ||
            code === "TextractThrottled" ||
            code === "ServiceUnavailableException" ||
            code === "InternalServerError"
          ) {
            return json(
              200,
              {
                ok: true,
                demo: false,
                summary: { vendorName: null, totalAmount: null, date: null, fieldConfidence: {} },
                items: [],
                mainCategory: null,
                notice:
                  "自動解析を一時的に利用できませんでした。店舗名・金額・日付を手入力して登録できます。",
                expenseIndex: null,
                totalCandidates: [],
                receiptGlobalDictionaryHitCount: 0,
              },
              hdrs,
              skipCors,
            );
          }
          return json(
            status,
            {
              error: code,
              detail:
                e instanceof Error
                  ? e.message
                  : typeof e === "string"
                    ? e
                    : "レシート解析に失敗しました。",
            },
            hdrs,
            skipCors,
          );
        }
      }

      case "POST /receipts/resolve-store-place":
      case "POST /receipts/resolve-suggested-vendor": {
        const b = JSON.parse(req.body || "{}");
        const resSubRej = rejectNonAdminSubscriptionBodyFields(b, hdrs, skipCors);
        if (resSubRej) return resSubRej;
        const subRowRes = await loadUserSubscriptionRowFull(pool, userId);
        if (!userHasPremiumSubscriptionAccess(subRowRes, userId)) {
          return json(
            403,
            {
              error: "SubscriptionRequired",
              detail: "店名の名寄せ（Amazon Bedrock）はプレミアム機能です。",
            },
            hdrs,
            skipCors,
          );
        }
        const vendorName =
          b.vendorName != null && String(b.vendorName).trim() !== ""
            ? String(b.vendorName).trim().slice(0, 200)
            : "";
        if (vendorName.length < 2) {
          return json(
            400,
            { error: "InvalidRequest", detail: "vendorName（店名）が必要です。" },
            hdrs,
            skipCors,
          );
        }
        try {
          const res = await resolveAndPersistUserStorePlace(pool, userId, vendorName);
          if (!res) {
            return json(200, { ok: true, found: false }, hdrs, skipCors);
          }
          if (res.ok === false) {
            return json(
              200,
              {
                ok: true,
                found: false,
                vendorResolveSkipped: true,
                userHint: res.userHint,
                reasonCode: res.bedrockCode ?? null,
                ocrVendorKey: res.ocrVendorKey,
              },
              hdrs,
              skipCors,
            );
          }
          return json(
            200,
            {
              ok: true,
              found: true,
              suggestedVendor: {
                fromCache: res.fromCache,
                placeId: res.placeId,
                suggestedStoreName: res.suggestedStoreName,
                locationHint: res.locationHint,
                suggestedExpenseCategoryName: res.suggestedExpenseCategoryName ?? null,
                saved: res.saved,
                ocrVendorKey: res.ocrVendorKey,
                inferenceConfidence: res.inferenceConfidence,
                inferenceLowConfidence: res.inferenceLowConfidence,
              },
            },
            hdrs,
            skipCors,
          );
        } catch (e) {
          logError("receipts.resolve_suggested_vendor", e);
          return json(
            500,
            { error: "ResolveVendorError", detail: "店名の名寄せ（Bedrock）に失敗しました。" },
            hdrs,
            skipCors,
          );
        }
      }

      case "POST /receipts/place-category-preference": {
        const b = JSON.parse(req.body || "{}");
        const prefSubRej = rejectNonAdminSubscriptionBodyFields(b, hdrs, skipCors);
        if (prefSubRej) return prefSubRej;
        const subRowPref = await loadUserSubscriptionRowFull(pool, userId);
        if (!userHasPremiumSubscriptionAccess(subRowPref, userId)) {
          return json(
            403,
            {
              error: "SubscriptionRequired",
              detail: "店名×カテゴリの学習はプレミアム機能です。",
            },
            hdrs,
            skipCors,
          );
        }
        const ocrKey = b.ocrVendorKey != null ? String(b.ocrVendorKey).trim() : "";
        if (!/^[a-f0-9]{64}$/i.test(ocrKey)) {
          return json(
            400,
            { error: "InvalidRequest", detail: "ocrVendorKey が不正です。" },
            hdrs,
            skipCors,
          );
        }
        let prefCategoryId = null;
        if (b.categoryId != null && b.categoryId !== "") {
          const n = Number(b.categoryId);
          if (!Number.isFinite(n) || n <= 0) {
            return json(
              400,
              { error: "InvalidRequest", detail: "categoryId が不正です。" },
              hdrs,
              skipCors,
            );
          }
          const [crows] = await pool.query(
            `SELECT c.id FROM categories c
             WHERE ${catWhere} AND c.id = ? AND c.is_archived = 0 AND c.kind = 'expense'
             LIMIT 1`,
            [userId, userId, n],
          );
          if (!Array.isArray(crows) || !crows[0]) {
            return json(
              400,
              { error: "InvalidRequest", detail: "指定のカテゴリが利用できません。" },
              hdrs,
              skipCors,
            );
          }
          prefCategoryId = n;
        }
        const vendorHint =
          b.vendorName != null && String(b.vendorName).trim() !== ""
            ? String(b.vendorName).trim().slice(0, 200)
            : "";
        try {
          const up = await upsertPreferredCategoryForOcrKey(
            pool,
            userId,
            ocrKey,
            prefCategoryId,
            vendorHint.length >= 2 ? vendorHint : null,
          );
          if (!up.ok) {
            return json(
              200,
              { ok: false, skipped: true, reason: up.reason ?? "unavailable" },
              hdrs,
              skipCors,
            );
          }
          return json(200, { ok: true, skipped: false }, hdrs, skipCors);
        } catch (e) {
          logError("receipts.place_category_preference", e);
          return json(
            500,
            { error: "PlaceCategoryPreferenceError", detail: "学習の保存に失敗しました。" },
            hdrs,
            skipCors,
          );
        }
      }

      case "POST /receipts/reclassify-uncategorized": {
        const b = JSON.parse(req.body || "{}");
        const subRej2 = rejectNonAdminSubscriptionBodyFields(b, hdrs, skipCors);
        if (subRej2) return subRej2;
        const batchSizeRaw = Number.parseInt(String(b.batchSize ?? "100"), 10);
        const batchSize =
          Number.isFinite(batchSizeRaw) && batchSizeRaw > 0
            ? Math.min(batchSizeRaw, 500)
            : 100;
        const maxBatchesRaw = Number.parseInt(String(b.maxBatches ?? "2000"), 10);
        const maxBatches =
          Number.isFinite(maxBatchesRaw) && maxBatchesRaw > 0
            ? Math.min(maxBatchesRaw, 5000)
            : 2000;

        const subRowReclass = await loadUserSubscriptionRowFull(pool, userId);
        const subscriptionActiveReclass = userHasPremiumSubscriptionAccess(subRowReclass, userId);
        const [reclassExpenseCats] = await pool.query(
          `SELECT c.id, c.name
           FROM categories c
           WHERE ${catWhere} AND c.is_archived = 0 AND c.kind = 'expense'
           ORDER BY c.sort_order, c.id`,
          [userId, userId],
        );
        const reclassExpenseCatRows = Array.isArray(reclassExpenseCats) ? reclassExpenseCats : [];

        let totalScanned = 0;
        let totalUpdated = 0;
        let offset = 0;
        let batches = 0;

        while (batches < maxBatches) {
          const [rows] = await pool.query(
            `SELECT t.id, t.memo
             FROM transactions t
             WHERE ${txWhere}
               AND t.kind = 'expense'
               AND t.category_id IS NULL
               AND t.memo IS NOT NULL
               AND TRIM(t.memo) <> ''
             ORDER BY t.transaction_date ASC, t.id ASC
             LIMIT ? OFFSET ?`,
            [...txP2, batchSize, offset],
          );
          const list = Array.isArray(rows) ? rows : [];
          if (list.length === 0) break;

          batches += 1;
          let batchUpdated = 0;
          for (const r of list) {
            const txId = Number(r.id);
            const memo = String(r.memo ?? "");
            if (!Number.isFinite(txId) || !memo.trim()) continue;
            const suggestion = await suggestExpenseCategoryForMemo(
              pool,
              userId,
              catWhere,
              txWhere,
              familyId,
              memo,
              reclassExpenseCatRows,
              subscriptionActiveReclass,
              txP2,
            );
            if (!suggestion?.id) continue;
            const [upd] = await pool.query(
              `UPDATE transactions t
               SET t.category_id = ?
               WHERE t.id = ? AND (${txWhere}) AND t.category_id IS NULL`,
              [suggestion.id, txId, ...txP2],
            );
            if (upd?.affectedRows) {
              batchUpdated += 1;
              totalUpdated += 1;
            }
          }
          totalScanned += list.length;
          if (batchUpdated > 0) {
            offset = 0;
          } else {
            offset += list.length;
          }
        }

        return json(
          200,
          {
            ok: true,
            scanned: totalScanned,
            updated: totalUpdated,
            batches,
            batchSize,
          },
          hdrs,
          skipCors,
        );
      }

      default:
        return json(404, { error: "Not Found", path, method }, hdrs, skipCors);
    }
  } catch (e) {
    if (e && typeof e === "object" && e.code === "DATABASE_NOT_CONFIGURED") {
      return json(
        503,
        {
          error: "DatabaseNotConfigured",
          detail: e instanceof Error ? e.message : String(e),
        },
        hdrs,
        skipCors,
      );
    }
    logError("api.unhandled", e, { method, path });
    const dev = process.env.NODE_ENV === "development";
    const dbCode =
      e && typeof e === "object" && e.code != null ? String(e.code) : "";
    const errno =
      e && typeof e === "object" && typeof e.errno === "number"
        ? e.errno
        : null;
    const detail = dev
      ? e instanceof Error
        ? e.message
        : String(e)
      : dbCode || errno != null
        ? dbCode || `errno:${errno}`
        : undefined;
    return json(
      500,
      {
        error: "InternalError",
        ...(detail ? { detail } : {}),
      },
      hdrs,
      skipCors,
    );
  }
}

/**
 * 内部: /receipts/parse 再呼び出し用（Bearer / X-User-Id だけ引き回す）
 */
function pickAuthHeadersForInternalParse(src) {
  if (!src || typeof src !== "object") return {};
  const auth = src.authorization ?? src.Authorization;
  const xu = src["x-user-id"] ?? src["X-User-Id"];
  const out = {};
  if (auth) out.authorization = String(auth);
  if (xu != null && String(xu) !== "") out["x-user-id"] = String(xu);
  return out;
}

/**
 * 受付直後: DB の pending ジョブに対し、同ユーザーの /receipts/parse 相当を実行して結果を保存する。
 * （Fargate 等の常駐プロセスで有効。Lambda ではレスポンス後の実行が途切れる場合がある。）
 */
async function runReceiptJobAfterUpload(pool, jobId, userId, forwardHeaders) {
  try {
    const [u] = await pool.query(
      `UPDATE receipt_processing_jobs SET status = 'processing', updated_at = NOW()
       WHERE job_id = ? AND user_id = ? AND status = 'pending'`,
      [jobId, userId],
    );
    if (!u?.affectedRows) {
      return;
    }
    const [[row]] = await pool.query(
      `SELECT request_json FROM receipt_processing_jobs WHERE job_id = ? AND user_id = ? LIMIT 1`,
      [jobId, userId],
    );
    if (!row?.request_json) {
      await pool.query(
        `UPDATE receipt_processing_jobs SET status = 'failed', error_message = 'missing request_json', updated_at = NOW() WHERE job_id = ?`,
        [jobId],
      );
      return;
    }
    const out = await handleApiRequest(
      {
        method: "POST",
        path: "/receipts/parse",
        body: String(row.request_json),
        headers: forwardHeaders,
      },
      { skipCors: true },
    );
    const statusCode = Number(out.statusCode ?? 500) || 500;
    const raw = typeof out.body === "string" ? out.body : JSON.stringify(out.body ?? "");
    let parsed = {};
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      parsed = { _parseError: true, raw: raw ? raw.slice(0, 500) : "" };
    }
    if (statusCode >= 200 && statusCode < 300) {
      let toStore;
      try {
        toStore = raw ? JSON.parse(raw) : null;
      } catch {
        toStore = { _raw: raw };
      }
      await pool.query(
        `UPDATE receipt_processing_jobs
         SET status = 'completed', result_data = ?, error_message = NULL, updated_at = NOW()
         WHERE job_id = ?`,
        [toStore == null ? null : toStore, jobId],
      );
    } else {
      const detail =
        parsed && typeof parsed === "object" && (parsed.detail || parsed.error)
          ? String(parsed.detail || parsed.error)
          : `HTTP ${statusCode}`;
      await pool.query(
        `UPDATE receipt_processing_jobs
         SET status = 'failed', result_data = NULL, error_message = ?, updated_at = NOW()
         WHERE job_id = ?`,
        [detail.slice(0, 4000), jobId],
      );
    }
  } catch (e) {
    logError("receipts.job.run", e, { jobId, userId });
    try {
      const msg = e instanceof Error ? e.message : String(e);
      await pool.query(
        `UPDATE receipt_processing_jobs
         SET status = 'failed', error_message = ?, updated_at = NOW()
         WHERE job_id = ? AND user_id = ?`,
        [msg.slice(0, 4000), jobId, userId],
      );
    } catch {
      /* ignore */
    }
  }
}

export { resolveUserId };
