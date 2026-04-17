import {
  BedrockRuntimeClient,
  ConverseCommand,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { createLogger } from "./logger.mjs";

const logger = createLogger("bedrock");

const DEFAULT_REGION = "ap-northeast-1";

/**
 * Bedrock 公式のモデル ID（model-ids / コンソールのプロバイダー詳細の表記に準拠）。
 * 試行優先順: Claude Sonnet 4.6 → 3.7 Sonnet → 3.5 Sonnet v1。
 *
 * 指示にあった `anthropic.claude-4-6-sonnet-20260301-v1:0` および
 * `anthropic.claude-3-7-sonnet-20251101-v1:0` は公式一覧に無いため、
 * Sonnet 4.6 は `anthropic.claude-sonnet-4-6`、3.7 は `20250219` の ID を使用する。
 * @see https://docs.aws.amazon.com/bedrock/latest/userguide/model-ids.html
 */
const BEDROCK_MODEL_ID_SONNET_4_6 = "anthropic.claude-sonnet-4-6";
const BEDROCK_MODEL_ID_SONNET_3_7 = "anthropic.claude-3-7-sonnet-20250219-v1:0";
/** レガシー v1 — リージョンによっては EOL（ResourceNotFound）のため v2 を優先 */
const BEDROCK_MODEL_ID_SONNET_3_5_V2 = "anthropic.claude-3-5-sonnet-20241022-v2:0";
const BEDROCK_MODEL_ID_SONNET_3_5_V1 = "anthropic.claude-3-5-sonnet-20240620-v1:0";

/** Bedrock コンソールのモデル ID と完全一致させる（余計な空白・囲みクォートは除去） */
function sanitizeBedrockModelId(raw) {
  let s = String(raw ?? "").trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s.replace(/\s+/g, "");
}

function geoInferencePrefixForRegion(region) {
  const r = String(region || DEFAULT_REGION).toLowerCase().trim() || DEFAULT_REGION;
  if (r.startsWith("eu-")) return "eu";
  if (r.startsWith("ap-")) return "apac";
  if (r.startsWith("us-") || r.startsWith("ca-") || r.startsWith("mx-")) return "us";
  if (r.startsWith("sa-")) return "us";
  return "us";
}

/**
 * 上から順に試行。各モデルは global → 地域推論プロファイル → 基盤 ID。
 * @see https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html
 */
function defaultBedrockModelCandidates(region) {
  const geo = geoInferencePrefixForRegion(region);
  return [
    `global.${BEDROCK_MODEL_ID_SONNET_4_6}`,
    `${geo}.${BEDROCK_MODEL_ID_SONNET_4_6}`,
    BEDROCK_MODEL_ID_SONNET_4_6,
    `${geo}.${BEDROCK_MODEL_ID_SONNET_3_7}`,
    BEDROCK_MODEL_ID_SONNET_3_7,
    `${geo}.${BEDROCK_MODEL_ID_SONNET_3_5_V2}`,
    BEDROCK_MODEL_ID_SONNET_3_5_V2,
    `${geo}.${BEDROCK_MODEL_ID_SONNET_3_5_V1}`,
    BEDROCK_MODEL_ID_SONNET_3_5_V1,
  ].filter((x, i, arr) => arr.indexOf(x) === i);
}

function getBedrockConfig() {
  const region =
    String(process.env.BEDROCK_REGION || process.env.AWS_REGION || DEFAULT_REGION).trim() ||
    DEFAULT_REGION;
  const explicit = sanitizeBedrockModelId(process.env.BEDROCK_MODEL_ID);
  const defaults = defaultBedrockModelCandidates(region);
  const candidates = [...(explicit ? [explicit] : []), ...defaults]
    .map((x) => sanitizeBedrockModelId(x))
    .filter(Boolean)
    .filter((x, i, arr) => arr.indexOf(x) === i);
  const modelId = explicit || defaults[0];
  return { region, modelId, candidates };
}

function buildPrompt(message, context) {
  const history = Array.isArray(context?.history)
    ? context.history
        .filter((x) => x && (x.role === "user" || x.role === "ai") && typeof x.text === "string")
        .slice(-8)
        .map((x) => ({
          role: x.role === "ai" ? "assistant" : "user",
          text: String(x.text).trim().slice(0, 240),
        }))
    : [];
  const income = Number(context?.incomeTotal ?? 0);
  const expense = Number(context?.expenseTotal ?? 0);
  const fixedFromSettings = Number(context?.fixedCostFromSettings ?? 0);
  const netMonthly =
    context?.netMonthlyBalance != null && Number.isFinite(Number(context.netMonthlyBalance))
      ? Math.round(Number(context.netMonthlyBalance))
      : Math.round(income - expense - fixedFromSettings);
  const remaining = netMonthly;
  const top = Array.isArray(context?.topCategories) ? context.topCategories : [];
  const topReadable = top
    .slice(0, 6)
    .map((c, i) => {
      const name = c?.name != null ? String(c.name) : "未分類";
      const t = Number(c?.total ?? 0);
      return `${i + 1}位:${name} ${t.toLocaleString("ja-JP")}円`;
    })
    .join(" / ");
  const systemPrompt = [
    "あなたは親しみやすく、かつ専門的な知見を持つ「AI家計アドバイザー」です。丁寧語で、堅すぎないトーンを保ってください。",
    "ユーザーの家計状況（対象月・残金・支出内訳など）は、直後のユーザーメッセージブロックにまとめて渡されます。それが家計簿から集計された正本です。データに基づいた具体的な提案を優先してください。",
    "金額・カテゴリ別の数値は、そのブロックに明示されているものだけを引用してください。推測・例示・創作の金額は禁止です。",
    "JSONの上位カテゴリに無いラベル（例:「固定費」）に、勝手に具体額を当てはめないでください。言及するときは与えられたカテゴリ名だけを使うか、ユーザーに確認してください。",
    "残り予算・あといくら・使える金額と聞かれたら、必ず与えられた「収支残金」の数値だけを使い、他の金額と矛盾させないでください。",
    "天気・現在時刻・ニュースなど、ここに無いリアルタイム情報は正確には分かりません。「機能がありません」「お答えできません」だけで拒否せず、ユーモアや軽い一言で受け止めたうえで、家計アドバイザーとして与えられた残金・カテゴリに自然につなげてください（例: 時刻は分からないが、家計簿を見るなら今が見直しチャンスかも、など）。",
    "家計と無関係な雑談（ラッキー食材・豆知識など）には、まずその話に応じ、続けて家計データへ1文だけ軽く橋渡ししてください。",
    "家計の質問では、結論を先に述べ、質問のキーワードを1つ以上そのまま含めてください。カテゴリや節約の話では、上位カテゴリの名前を明示してください。",
    "毎回同じ締め（「お気軽にどうぞ」等）を繰り返さず、直前の会話やトーンに合わせて言い換えてください。",
    "会話履歴がある場合は直近の意図を優先し、文脈と矛盾しないでください。",
    "回答はおおよそ3〜4行を目安に、読みやすく。絵文字は適度に使ってください。",
  ].join("\n");
  const userPrompt = [
    "【家計コンテキスト・正本（ここに無い数値は使わない）】",
    `対象月: ${context?.yearMonth ?? "不明"}`,
    `収入合計: ${income.toLocaleString("ja-JP")}円`,
    `変動費支出（家計簿・「固定費」カテゴリの取引は除外済み）: ${expense.toLocaleString("ja-JP")}円`,
    `設定の固定費（月額合計）: ${fixedFromSettings.toLocaleString("ja-JP")}円`,
    `収支残金（収入−変動費−設定固定費。負もあり得ます）: ${remaining.toLocaleString("ja-JP")}円`,
    `支出カテゴリ上位（要約）: ${topReadable || "（データなし）"}`,
    `支出カテゴリ上位（機械可読・多い順）: ${JSON.stringify(top.slice(0, 10))}`,
    `直近会話: ${JSON.stringify(history)}`,
    "---",
    `ユーザー質問: ${message}`,
  ].join("\n");
  return { systemPrompt, userPrompt };
}

function mapAwsError(e) {
  const code = String(e?.name || e?.Code || "ModelInvokeError");
  const message = String(e?.message || "モデルの呼び出しに失敗しました");
  const throttled =
    code === "ThrottlingException" ||
    code === "TooManyRequestsException" ||
    message.includes("rate");
  const authFailed =
    code === "AccessDeniedException" ||
    code === "UnrecognizedClientException" ||
    code === "ExpiredTokenException" ||
    code === "InvalidClientTokenId";
  const validationFailed =
    code === "ValidationException" || message.includes("ValidationException");
  return { code, message, throttled, authFailed, validationFailed };
}

function serializeAwsError(e) {
  if (!e || typeof e !== "object") return { raw: String(e) };
  return {
    name: e.name,
    message: e.message,
    code: e.Code ?? e.code,
    requestId: e.$metadata?.requestId,
    httpStatusCode: e.$metadata?.httpStatusCode,
  };
}

function isThrottlingError(e) {
  const code = String(e?.name || e?.Code || "");
  return (
    code === "ThrottlingException" ||
    code === "TooManyRequestsException" ||
    String(e?.message || "").includes("Throttling")
  );
}

function isValidationError(e) {
  const code = String(e?.name || e?.Code || "");
  return code === "ValidationException" || String(e?.message || "").includes("ValidationException");
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function withThrottleRetry(operation, label, maxRetries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (e) {
      lastErr = e;
      if (isThrottlingError(e) && attempt < maxRetries) {
        const delay = 350 * 2 ** attempt;
        logger.warn("throttle_retry", {
          label,
          attempt: attempt + 1,
          delayMs: delay,
          ...serializeAwsError(e),
        });
        await sleep(delay);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

function parseClaudeInvokeText(data) {
  const content = Array.isArray(data?.content) ? data.content : [];
  const texts = content
    .filter((x) => x && x.type === "text" && typeof x.text === "string")
    .map((x) => String(x.text).trim())
    .filter(Boolean);
  return texts.join("\n").trim();
}

function parseConverseAssistantText(res) {
  const blocks = res?.output?.message?.content ?? [];
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((b) => b && typeof b.text === "string")
    .map((b) => String(b.text).trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function buildInvokeBodyBlocks(systemPrompt, userPrompt, maxTokens, temperature) {
  return JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: maxTokens,
    temperature,
    system: systemPrompt,
    messages: [
      { role: "user", content: [{ type: "text", text: userPrompt }] },
    ],
  });
}

/** 一部モデル／プロファイルは文字列 content のみ受け付ける */
function buildInvokeBodyStringContent(systemPrompt, userPrompt, maxTokens, temperature) {
  return JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: maxTokens,
    temperature,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
}

/** Bedrock Claude メッセージ API: レシート画像（base64）＋テキスト指示 */
function buildReceiptVisionInvokeBody(
  systemPrompt,
  textPrompt,
  imageBase64,
  mediaType,
  maxTokens,
  temperature,
) {
  const mt =
    mediaType === "image/png"
      ? "image/png"
      : mediaType === "image/webp"
        ? "image/webp"
        : "image/jpeg";
  return JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: maxTokens,
    temperature,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mt,
              data: imageBase64,
            },
          },
          { type: "text", text: textPrompt },
        ],
      },
    ],
  });
}

/** 推定バイナリ長の目安（約 4.5MB base64 ≒ 3.4MB 画像） */
const MAX_RECEIPT_VISION_BASE64_CHARS = 4_500_000;

/**
 * レシート画像を直接モデルへ送り JSON テキストを得る。失敗時は呼び出し元でテキストのみ経路へフォールバック。
 */
async function invokeBedrockReceiptVision({
  systemPrompt,
  textPrompt,
  imageBase64,
  mediaType,
  maxTokens = 900,
  temperature = 0.15,
}) {
  const raw = String(imageBase64 ?? "").replace(/\s/g, "");
  if (!raw || raw.length > MAX_RECEIPT_VISION_BASE64_CHARS) {
    logger.warn("receipt_vision_skip", {
      reason: !raw ? "empty" : "too_large",
      len: raw.length,
    });
    return { ok: false, code: "VisionSkipped", message: "No image or too large for vision" };
  }

  const { region, candidates } = getBedrockConfig();
  if (!candidates.length) {
    return { ok: false, code: "NoModelConfig", message: "モデル候補がありません" };
  }

  const client = new BedrockRuntimeClient({ region });
  let lastErr = null;

  for (const mid of candidates) {
    const body = buildReceiptVisionInvokeBody(
      systemPrompt,
      textPrompt,
      raw,
      mediaType,
      maxTokens,
      temperature,
    );
    try {
      logger.info("receipt_vision_try", { modelId: mid, region, b64Chars: raw.length });
      const reply = await tryInvokeModel(client, mid, body, "receipt_vision");
      if (reply && String(reply).trim()) {
        logger.info("receipt_vision_ok", { modelId: mid });
        return { ok: true, reply: String(reply).trim(), modelId: mid };
      }
    } catch (e) {
      lastErr = e;
      logger.warn("receipt_vision_model_failed", {
        modelId: mid,
        ...serializeAwsError(e),
      });
    }
  }

  return {
    ok: false,
    code: "VisionAllModelsFailed",
    message: lastErr instanceof Error ? lastErr.message : String(lastErr ?? "vision failed"),
    ...mapAwsError(lastErr),
  };
}

export function inferReceiptImageMediaTypeFromBuffer(buf) {
  if (!buf || buf.length < 4) return "image/jpeg";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return "image/webp";
  }
  return "image/jpeg";
}

async function tryInvokeModel(client, modelId, body, label) {
  return withThrottleRetry(async () => {
    const params = {
      modelId,
      contentType: "application/json",
      accept: "application/json",
      bodyLength: typeof body === "string" ? body.length : 0,
      label,
    };
    logger.info("bedrock_invoke_model_params", params);
    if (process.env.BEDROCK_DEBUG_LOG === "1") {
      console.log("[bedrock] InvokeModel params:", JSON.stringify(params));
    }
    const cmd = new InvokeModelCommand({
      modelId,
      contentType: "application/json",
      accept: "application/json",
      body,
    });
    const res = await client.send(cmd);
    const httpStatusCode = res.$metadata?.httpStatusCode;
    const raw = Buffer.from(res.body ?? new Uint8Array()).toString("utf-8");
    const data = JSON.parse(raw || "{}");
    const replyText = parseClaudeInvokeText(data);
    logger.info("bedrock_invoke_model_response", {
      modelId,
      label,
      httpStatusCode,
      bodyCharLength: raw.length,
      replyCharLength: replyText.length,
      replyPreview: replyText.slice(0, 240),
    });
    if (process.env.BEDROCK_DEBUG_LOG === "1") {
      console.log(
        "[bedrock] InvokeModel response:",
        JSON.stringify({
          modelId,
          httpStatusCode,
          replyPreview: replyText.slice(0, 300),
        }),
      );
    }
    return replyText;
  }, `invoke:${label}:${modelId}`);
}

async function tryConverse(client, modelId, systemPrompt, userPrompt, maxTokens, temperature) {
  return withThrottleRetry(async () => {
    const params = {
      modelId,
      maxTokens,
      temperature,
      systemLen: systemPrompt.length,
      userLen: userPrompt.length,
    };
    logger.info("bedrock_converse_params", params);
    if (process.env.BEDROCK_DEBUG_LOG === "1") {
      console.log("[bedrock] Converse params:", JSON.stringify(params));
    }
    const cmd = new ConverseCommand({
      modelId,
      system: [{ text: systemPrompt }],
      messages: [{ role: "user", content: [{ text: userPrompt }] }],
      inferenceConfig: {
        maxTokens,
        temperature,
      },
    });
    const res = await client.send(cmd);
    const httpStatusCode = res.$metadata?.httpStatusCode;
    const replyText = parseConverseAssistantText(res);
    logger.info("bedrock_converse_response", {
      modelId,
      httpStatusCode,
      replyCharLength: replyText.length,
      replyPreview: replyText.slice(0, 240),
    });
    if (process.env.BEDROCK_DEBUG_LOG === "1") {
      console.log(
        "[bedrock] Converse response:",
        JSON.stringify({
          modelId,
          httpStatusCode,
          replyPreview: replyText.slice(0, 300),
        }),
      );
    }
    return replyText;
  }, `converse:${modelId}`);
}

/**
 * 1モデルに対し Invoke（blocks → string）→ Converse の順で試す。
 */
async function invokeOneModel(client, modelId, systemPrompt, userPrompt, maxTokens, temperature) {
  const attempts = [];

  try {
    const bodyBlocks = buildInvokeBodyBlocks(
      systemPrompt,
      userPrompt,
      maxTokens,
      temperature,
    );
    const replyB = await tryInvokeModel(client, modelId, bodyBlocks, "blocks");
    attempts.push({ kind: "invoke_blocks", ok: true, replyLen: replyB.length });
    if (replyB) return { ok: true, reply: replyB, via: "invoke_blocks", attempts };
    attempts.push({ kind: "invoke_blocks", error: "empty_model_output" });
  } catch (e) {
    attempts.push({ kind: "invoke_blocks", error: serializeAwsError(e) });
    logger.warn("model_attempt_failed", {
      modelId,
      kind: "invoke_blocks",
      ...serializeAwsError(e),
    });
    if (!isValidationError(e)) {
      return { ok: false, lastError: e, attempts };
    }
  }

  try {
    const bodyStr = buildInvokeBodyStringContent(
      systemPrompt,
      userPrompt,
      maxTokens,
      temperature,
    );
    const replyS = await tryInvokeModel(client, modelId, bodyStr, "string");
    attempts.push({ kind: "invoke_string", ok: true, replyLen: replyS.length });
    if (replyS) return { ok: true, reply: replyS, via: "invoke_string", attempts };
    attempts.push({ kind: "invoke_string", error: "empty_model_output" });
  } catch (e) {
    attempts.push({ kind: "invoke_string", error: serializeAwsError(e) });
    logger.warn("model_attempt_failed", {
      modelId,
      kind: "invoke_string",
      ...serializeAwsError(e),
    });
    if (!isValidationError(e)) {
      return { ok: false, lastError: e, attempts };
    }
  }

  try {
    const replyC = await tryConverse(
      client,
      modelId,
      systemPrompt,
      userPrompt,
      maxTokens,
      temperature,
    );
    attempts.push({ kind: "converse", ok: true, replyLen: replyC.length });
    if (replyC) return { ok: true, reply: replyC, via: "converse", attempts };
    attempts.push({ kind: "converse", error: "empty_model_output" });
    return {
      ok: false,
      lastError: new Error("Converse returned empty text"),
      attempts,
    };
  } catch (e) {
    attempts.push({ kind: "converse", error: serializeAwsError(e) });
    logger.warn("model_attempt_failed", {
      modelId,
      kind: "converse",
      ...serializeAwsError(e),
    });
    return { ok: false, lastError: e, attempts };
  }
}

async function invokeBedrockText({ systemPrompt, userPrompt, maxTokens = 300, temperature = 0.4 }) {
  const { region, modelId, candidates } = getBedrockConfig();
  if (!modelId || candidates.length === 0) {
    return {
      ok: false,
      code: "NoModelConfig",
      message: "モデル候補がありません（リージョンまたは環境変数を確認してください）",
      authFailed: false,
      throttled: false,
      validationFailed: false,
    };
  }

  const client = new BedrockRuntimeClient({ region });
  let lastErr = null;
  const allAttempts = [];

  for (const mid of candidates) {
    logger.info("try_model", {
      modelId: mid,
      region,
      maxTokens,
      temperature,
      systemLen: systemPrompt.length,
      userLen: userPrompt.length,
    });

    const result = await invokeOneModel(
      client,
      mid,
      systemPrompt,
      userPrompt,
      maxTokens,
      temperature,
    );

    if (result.attempts) allAttempts.push({ modelId: mid, attempts: result.attempts });

    if (result.ok && result.reply) {
      logger.info("invoke_ok", { modelId: mid, via: result.via });
      return { ok: true, reply: result.reply, modelId: mid, via: result.via };
    }

    lastErr = result.lastError || lastErr;
    if (lastErr) {
      logger.error("model_exhausted", lastErr, {
        modelId: mid,
        ...serializeAwsError(lastErr),
      });
    }
  }

  logger.error("all_models_failed", lastErr || new Error("unknown"), {
    candidateCount: candidates.length,
    attemptsSummary: allAttempts,
  });

  return {
    ok: false,
    ...mapAwsError(lastErr),
    modelId,
    attemptsLog: allAttempts,
  };
}

export async function askBedrockAdvisor(message, context) {
  const { systemPrompt, userPrompt } = buildPrompt(message, context);
  return invokeBedrockText({ systemPrompt, userPrompt, maxTokens: 320, temperature: 0.2 });
}

function parseJsonBlock(raw) {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const src = fenced ? fenced[1] : t;
  try {
    return JSON.parse(src);
  } catch {
    return null;
  }
}

function normalizeReceiptAiPayload(data) {
  if (!data || typeof data !== "object") return null;
  let vendorName = data.vendorName;
  if (vendorName != null) {
    const v = String(vendorName).trim();
    vendorName = v === "" || /^不明$/u.test(v) ? null : v.slice(0, 120);
  } else {
    vendorName = null;
  }
  let date = data.date != null ? String(data.date).trim() : null;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) date = null;
  let totalAmount = data.totalAmount;
  if (totalAmount != null) {
    const n = Number(totalAmount);
    totalAmount = Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  } else {
    totalAmount = null;
  }
  let categoryName = data.categoryName != null ? String(data.categoryName).trim() : null;
  if (categoryName === "" || /^不明$/u.test(categoryName)) categoryName = null;
  const reason = data.reason != null ? String(data.reason).trim().slice(0, 500) : "";
  return { vendorName, date, totalAmount, categoryName, reason };
}

/**
 * @param {object} opts
 * @param {boolean} opts.subscriptionActive
 * @param {Record<string, unknown>} opts.summary
 * @param {unknown[]} opts.items
 * @param {string[]} opts.ocrLines
 * @param {string[]} opts.categoryCandidates
 * @param {object[]} opts.historyHints
 * @param {object|null} [opts.heuristicCategorySuggestion]
 */
function buildReceiptAiPromptBundle(opts) {
  const subscriptionActive = Boolean(opts.subscriptionActive);
  const summary = opts.summary;
  const items = opts.items;
  const ocrLines = opts.ocrLines;
  const categoryCandidates = opts.categoryCandidates;
  const historyHints = opts.historyHints;
  const heuristic = opts.heuristicCategorySuggestion ?? null;

  if (!subscriptionActive) {
    const systemPrompt = [
      "あなたは家計簿アプリのレシート読取AI（無料プラン用）です。",
      "無料プランでは日付（date）と税込合計（totalAmount）の抽出に専念してください。",
      "vendorName と categoryName は常に null を返してください（店名・カテゴリ推定は行わない）。",
      "totalAmount と date は、添付画像に写っている文字、または補助JSONの ocrLines に読み取り根拠がある場合に限り出力してください。",
      "合計はレシートに印字された「合計」「お支払額」等に対応する数値のみ。明細行の足し合わせは、画像または ocrLines に明細金額が列挙されているときに限り可。",
      "一般知識・履歴・推測で店名やカテゴリを補完しないでください。",
      "補助JSONには ocrLines のみ含まれます。Textract の構造化 summary/items は渡しません。",
      "必ず1つのJSONオブジェクトのみを返す。前後に説明文やマークダウンを付けない。",
    ].join("\n");

    const auxPayload = {
      ocrLines,
      note: "ocrLines のみ（画像由来の生テキスト行）。",
    };

    const userTextPrompt = [
      "無料プラン: 画像と ocrLines の根拠のみで、date と totalAmount を埋めてください。",
      "出力キー: vendorName, date, totalAmount, categoryName, reason（キーはすべて必須）",
      "- vendorName: 必ず null",
      "- date: YYYY-MM-DD、根拠なしなら null",
      "- totalAmount: 根拠ある税込合計（円の数値）、なければ null",
      "- categoryName: 必ず null",
      "- reason: 日付・合計をどの文字から読んだか1文（日本語）",
      "",
      "補助JSON:",
      JSON.stringify(auxPayload),
    ].join("\n");

    return { systemPrompt, userTextPrompt, receiptAiTier: "free" };
  }

  const catList =
    categoryCandidates.length > 0
      ? categoryCandidates.join("、")
      : "（カテゴリ一覧なし。一般的な日本の家計簿名で推定）";

  const systemPrompt = [
    "あなたは家計簿アプリのレシート読取AI（サブスクリプション有効ユーザー向け）です。",
    "添付画像の文字・レイアウトを最優先し、補助JSONの Textract summary/items/ocrLines を積極的に参照してください。",
    "利用履歴ヒント historyHints は同一家族の過去支出（メモ・金額・日付・カテゴリ）です。画像上の店名が不完全でも、履歴と突き合わせて最も妥当な vendorName を推定してよい。",
    "履歴と矛盾しない範囲で、定番チェーン店・屋号の正規化（略称→正式名称など）を行ってよい。",
    `categoryName は次の登録済み名のいずれかに最も近い1つ: ${catList}`,
    "合計が印字不明でも、明細が読めれば足し合わせて totalAmount を埋めてよい。",
    "日付は YYYY-MM-DD。読めなければ null。",
    "必ず1つのJSONオブジェクトのみを返す。前後に説明文やマークダウンを付けない。",
  ].join("\n");

  const auxPayload = {
    summary,
    items,
    ocrLines,
    categoryCandidates,
    historyHints,
    heuristicCategorySuggestion: heuristic,
  };

  const userTextPrompt = [
    "添付レシート画像（ある場合）と、補助JSON全体（履歴・ヒューリスティック候補を含む）を踏まえて抽出・補正してください。",
    "出力キー: vendorName, date, totalAmount, categoryName, reason",
    "- vendorName: 店舗名（履歴ヒントで特定を強力にサポートしてよい）。困難なら null",
    "- date: YYYY-MM-DD または null",
    "- totalAmount: 税込合計（円）。明細からの合算可。だめなら null",
    "- categoryName: 登録カテゴリ一覧に最も近い文字列、または null",
    "- reason: 判断根拠を1文（日本語）。画像・履歴・補助JSONのどれを重視したか分かるように",
    "",
    "補助JSON:",
    JSON.stringify(auxPayload),
  ].join("\n");

  return { systemPrompt, userTextPrompt, receiptAiTier: "subscribed" };
}

/**
 * @param {object} input
 * @param {boolean} [input.subscriptionActive] true のとき有料プロンプト（履歴ヒント・全補助JSON）
 * @param {object[]} [input.historyHints] { date, memo, amount, categoryName }
 * @param {object|null} [input.heuristicCategorySuggestion] { name, source }
 * @param {Record<string, unknown>} [input.summary]
 * @param {unknown[]} [input.items]
 * @param {string[]} [input.ocrLines]
 * @param {string[]} [input.categoryCandidates]
 * @param {string} [input.imageBase64]
 * @param {string} [input.imageMediaType]
 */
export async function askBedrockReceiptAssistant(input = {}) {
  const summary = input?.summary && typeof input.summary === "object" ? input.summary : {};
  const items = Array.isArray(input?.items) ? input.items : [];
  const ocrLines = Array.isArray(input?.ocrLines) ? input.ocrLines : [];
  const categoryCandidates = Array.isArray(input?.categoryCandidates)
    ? input.categoryCandidates.map((x) => String(x ?? "").trim()).filter(Boolean)
    : [];
  const historyHints = Array.isArray(input?.historyHints) ? input.historyHints : [];
  const heuristicCategorySuggestion =
    input?.heuristicCategorySuggestion &&
    typeof input.heuristicCategorySuggestion === "object"
      ? input.heuristicCategorySuggestion
      : null;
  const subscriptionActive = Boolean(input?.subscriptionActive);
  const imageBase64 = input?.imageBase64 != null ? String(input.imageBase64) : "";
  const imageMediaType =
    input?.imageMediaType != null ? String(input.imageMediaType).toLowerCase() : "image/jpeg";

  const { systemPrompt, userTextPrompt, receiptAiTier } = buildReceiptAiPromptBundle({
    subscriptionActive,
    summary,
    items,
    ocrLines,
    categoryCandidates,
    historyHints,
    heuristicCategorySuggestion,
  });

  let rawReply = "";
  let receiptAiSource = "text";

  if (imageBase64 && imageBase64.trim()) {
    const vis = await invokeBedrockReceiptVision({
      systemPrompt,
      textPrompt: userTextPrompt,
      imageBase64,
      mediaType: imageMediaType,
      maxTokens: 900,
      temperature: 0.15,
    });
    if (vis.ok && vis.reply) {
      rawReply = vis.reply;
      receiptAiSource = "vision";
    }
  }

  if (!rawReply) {
    const textOnlyPrompt = [
      userTextPrompt,
      "",
      "※画像は利用できないため、次のテキスト情報のみから推定してください。",
    ].join("\n");
    const out = await invokeBedrockText({
      systemPrompt,
      userPrompt: textOnlyPrompt,
      maxTokens: 700,
      temperature: 0.2,
    });
    if (!out?.ok) return out;
    rawReply = out.reply;
  }

  const parsed = parseJsonBlock(rawReply);
  const data = normalizeReceiptAiPayload(parsed);
  if (!data) {
    return { ok: false, code: "InvalidModelJson", message: "Receipt AI JSON parse failed" };
  }
  return { ok: true, data, receiptAiSource, receiptAiTier };
}
