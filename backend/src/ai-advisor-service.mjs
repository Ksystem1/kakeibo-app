import {
  BedrockRuntimeClient,
  ConverseCommand,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { createLogger } from "./logger.mjs";

const logger = createLogger("bedrock");

const DEFAULT_REGION = "ap-northeast-1";
const BEDROCK_SEND_TIMEOUT_MS = Math.max(
  8_000,
  Number.parseInt(String(process.env.BEDROCK_SEND_TIMEOUT_MS ?? "16000"), 10) || 16_000,
);

async function withTimeout(promise, ms, label) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout (${ms}ms)`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
const BEDROCK_MODEL_ID_HAIKU_3_5 = "anthropic.claude-3-5-haiku-20241022-v1:0";

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
/** レシート店名名寄せ（Claude 3.5 Sonnet のみ試行: v2 優先 → v1） */
function claude35SonnetModelCandidates(region) {
  const geo = geoInferencePrefixForRegion(region);
  return [
    `global.${BEDROCK_MODEL_ID_SONNET_3_5_V2}`,
    `${geo}.${BEDROCK_MODEL_ID_SONNET_3_5_V2}`,
    BEDROCK_MODEL_ID_SONNET_3_5_V2,
    `${geo}.${BEDROCK_MODEL_ID_SONNET_3_5_V1}`,
    BEDROCK_MODEL_ID_SONNET_3_5_V1,
  ].filter((x, i, arr) => arr.indexOf(x) === i);
}

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

function fastReceiptModelCandidates(region) {
  const geo = geoInferencePrefixForRegion(region);
  return [
    `global.${BEDROCK_MODEL_ID_HAIKU_3_5}`,
    `${geo}.${BEDROCK_MODEL_ID_HAIKU_3_5}`,
    BEDROCK_MODEL_ID_HAIKU_3_5,
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
  const fixedInNet = income > 0 || expense > 0 ? fixedFromSettings : 0;
  const netMonthly =
    context?.netMonthlyBalance != null && Number.isFinite(Number(context.netMonthlyBalance))
      ? Math.round(Number(context.netMonthlyBalance))
      : Math.round(income - expense - fixedInNet);
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
    `収支残金（収入も変動費も0円の月は固定費を差し引かない。それ以外は収入−変動費−設定固定費。負もあり得ます）: ${remaining.toLocaleString("ja-JP")}円`,
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
      const tVis = Date.now();
      logger.info("receipt_vision_try", { modelId: mid, region, b64Chars: raw.length });
      const reply = await tryInvokeModel(client, mid, body, "receipt_vision");
      if (reply && String(reply).trim()) {
        logger.info("receipt_vision_ok", { modelId: mid, durationMs: Date.now() - tVis, outputChars: String(reply).length });
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
    const res = await withTimeout(
      client.send(cmd),
      BEDROCK_SEND_TIMEOUT_MS,
      "Bedrock invoke",
    );
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
    const res = await withTimeout(
      client.send(cmd),
      BEDROCK_SEND_TIMEOUT_MS,
      "Bedrock converse",
    );
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

async function invokeBedrockText({
  systemPrompt,
  userPrompt,
  maxTokens = 300,
  temperature = 0.4,
  modelCandidates: modelCandidatesOverride = null,
  /** CloudWatch 分析用: bedrock.text / bedrock.text.vendor_resolve 等 */
  logContext = "bedrock.text",
} = {}) {
  const tAll = Date.now();
  const { region, modelId, candidates: defaultCandidates } = getBedrockConfig();
  const candidates = Array.isArray(modelCandidatesOverride) && modelCandidatesOverride.length > 0
    ? modelCandidatesOverride
    : defaultCandidates;
  if (!candidates || candidates.length === 0) {
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
    const t0 = Date.now();
    logger.info("try_model", {
      logContext,
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
    const attemptMs = Date.now() - t0;

    if (result.ok && result.reply) {
      const durationMs = Date.now() - tAll;
      logger.info("invoke_text_complete", {
        logContext,
        modelId: mid,
        via: result.via,
        lastAttemptDurationMs: attemptMs,
        durationMs,
        outputChars: String(result.reply).length,
      });
      return { ok: true, reply: result.reply, modelId: mid, via: result.via, durationMs, lastAttemptDurationMs: attemptMs };
    }

    lastErr = result.lastError || lastErr;
    const errForLog = result.lastError || lastErr;
    logger.warn("model_attempt_not_ok", {
      logContext,
      modelId: mid,
      lastAttemptDurationMs: attemptMs,
      ...serializeAwsError(errForLog),
    });
  }

  const durationMs = Date.now() - tAll;
  const mapped = lastErr ? mapAwsError(lastErr) : {
    code: "AllModelsFailed",
    message: "モデル応答を得られませんでした",
    throttled: false,
    authFailed: false,
    validationFailed: false,
  };
  logger.error("all_models_failed", lastErr || new Error("unknown"), {
    logContext,
    durationMs,
    candidateCount: candidates.length,
    ...mapped,
    aws: serializeAwsError(lastErr),
    attemptsSummary: allAttempts,
  });

  return {
    ok: false,
    ...mapped,
    modelId: modelId || candidates[0],
    durationMs,
    attemptsLog: allAttempts,
  };
}

export async function askBedrockAdvisor(message, context) {
  const { systemPrompt, userPrompt } = buildPrompt(message, context);
  return invokeBedrockText({
    systemPrompt,
    userPrompt,
    maxTokens: 320,
    temperature: 0.2,
    logContext: "bedrock.text.advisor",
  });
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

const BEDROCK_VENDOR_RESOLVE_MAX = 200;

/**
 * レシートOCR から推定店名・粗い地域・（任意）家計の支出カテゴリ名を 1 回の Bedrock 呼び出しで得る。
 * 支出カテゴリ名は `expenseCategoryNames` を UI（例: 設定画面のカテゴリ一覧・image_8c1cba.png 相当）と同じ集合として渡す。
 * モデルは **Claude 3.5 Sonnet** 系 ID のみを順に試行。外部地図 API は使わない。
 * @param {string} ocrText
 * @param {{ expenseCategoryNames?: string[] }} [options]
 * @returns {Promise<
 *   | {
 *       ok: true;
 *       suggestedStoreName: string;
 *       locationHint: string;
 *       suggestedExpenseCategoryName: string | null;
 *       inferenceConfidence: number;
 *       inferenceLowConfidence: boolean;
 *     }
 *   | { ok: false; code?: string }
 * >}
 */
export async function bedrockResolveSuggestedVendor(ocrText, options = {}) {
  const raw = String(ocrText ?? "").trim();
  if (raw.length < 2) return { ok: false, code: "InputTooShort" };
  const catList = Array.isArray(options?.expenseCategoryNames)
    ? options.expenseCategoryNames
        .map((n) => String(n ?? "").trim())
        .filter((n) => n.length > 0)
    : [];
  const catListDeduped = catList.filter((n, i, a) => a.indexOf(n) === i);
  const catBlock =
    catListDeduped.length > 0
      ? [
          "The user's expense category labels (use EXACTLY one string from this list for expenseCategoryName, or null if none fits):",
          JSON.stringify(catListDeduped),
          "expenseCategoryName must be null or byte-for-byte equal to one list entry. If unsure, use null.",
        ].join("\n")
      : "expenseCategoryName must be null (no category list was provided).";

  const systemPrompt = [
    "You analyze noisy Japanese receipt OCR to infer: (1) a natural, official-style store/brand name, (2) an optional region hint, (3) the best-matching spending category from the user-provided list if any, (4) your confidence.",
    "Answer with ONE JSON object only. No markdown fences, no other text, no explanation.",
    "JSON keys in this exact order of requirement:",
    "  suggestedStoreName: string, natural Japanese, max 120 characters.",
    "  locationHint: string (prefecture or city in Japan) or null. Never invent a full street address.",
    "  expenseCategoryName: string (exactly one from the list) or null.",
    "  inferenceConfidence: number from 0.0 to 1.0 only (subjective: certainty for suggestedStoreName and expenseCategoryName together; use a low value when OCR is ambiguous).",
    catBlock,
  ].join("\n");

  const userPrompt = ["OCR / raw merchant text (Japanese):", raw.slice(0, BEDROCK_VENDOR_RESOLVE_MAX)].join("\n");
  const region = String(
    process.env.BEDROCK_REGION || process.env.AWS_REGION || DEFAULT_REGION,
  ).trim() || DEFAULT_REGION;
  const modelCandidates = claude35SonnetModelCandidates(region);
  const out = await invokeBedrockText({
    systemPrompt,
    userPrompt,
    maxTokens: 500,
    temperature: 0.05,
    modelCandidates,
    logContext: "bedrock.text.vendor_resolve",
  });
  if (!out?.ok || !out.reply) {
    logger.warn("vendor_resolve_bedrock_fail", {
      code: out?.code,
      durationMs: out?.durationMs,
      authFailed: out?.authFailed,
      throttled: out?.throttled,
      validationFailed: out?.validationFailed,
    });
    return { ok: false, code: out?.code || "BedrockError" };
  }
  logger.info("vendor_resolve_bedrock_ok", {
    modelId: out.modelId,
    durationMs: out.durationMs,
    via: out.via,
  });
  const parsed = parseJsonBlock(String(out.reply));
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, code: "InvalidModelJson" };
  }
  let name =
    parsed.suggestedStoreName != null
      ? String(parsed.suggestedStoreName).trim()
      : parsed.displayName != null
        ? String(parsed.displayName).trim()
        : "";
  if (!name || /^(不明|unknown|N\/?A)$/i.test(name)) {
    return { ok: false, code: "NoStoreName" };
  }
  name = name.slice(0, 500);
  const locRaw = parsed.locationHint != null ? String(parsed.locationHint).trim() : "";
  const locationHint = locRaw ? locRaw.slice(0, 200) : "";
  const catFromModel = parsed.expenseCategoryName != null ? String(parsed.expenseCategoryName).trim() : "";
  let suggestedExpenseCategoryName = null;
  if (catListDeduped.length > 0 && catFromModel) {
    const match = catListDeduped.find((c) => c === catFromModel);
    suggestedExpenseCategoryName = match ?? null;
  }
  let conf = parsed.inferenceConfidence != null ? Number(parsed.inferenceConfidence) : Number.NaN;
  if (!Number.isFinite(conf)) conf = 0.55;
  const inferenceConfidence = Math.max(0, Math.min(1, conf));
  const inferenceLowConfidence = inferenceConfidence < 0.72;
  return {
    ok: true,
    suggestedStoreName: name,
    locationHint,
    suggestedExpenseCategoryName,
    inferenceConfidence,
    inferenceLowConfidence,
  };
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
  let taxAmount = data.taxAmount;
  if (taxAmount != null) {
    const t = Number(taxAmount);
    taxAmount = Number.isFinite(t) && t >= 0 ? Math.round(t) : null;
  } else {
    taxAmount = null;
  }
  let lineItems = null;
  if (Array.isArray(data.lineItems) && data.lineItems.length) {
    const raw = data.lineItems
      .map((x) => {
        if (!x || typeof x !== "object") return null;
        const name = String(x.name ?? x.itemName ?? "").trim() || "（品目）";
        const a = Number(x.amount ?? x.unitPrice ?? x.price ?? NaN);
        const amount = Number.isFinite(a) && a >= 0 ? Math.round(a) : null;
        return { name: name.slice(0, 200), amount };
      })
      .filter((x) => x != null);
    lineItems = raw.length ? raw.slice(0, 80) : null;
  }
  let categoryName = data.categoryName != null ? String(data.categoryName).trim() : null;
  if (categoryName === "" || /^不明$/u.test(categoryName)) categoryName = null;
  const reason = data.reason != null ? String(data.reason).trim().slice(0, 500) : "";
  return { vendorName, date, totalAmount, taxAmount, lineItems, categoryName, reason };
}

function normalizeHybridReceiptPayload(data) {
  if (!data || typeof data !== "object") return null;
  const allowedItemCategories = new Set([
    "食費",
    "日用品",
    "衣類",
    "娯楽",
    "医療",
    "教育",
    "交通費",
    "その他",
  ]);
  const storeRaw = data.storeName ?? data.vendorName ?? data.store ?? null;
  const storeName =
    storeRaw == null || String(storeRaw).trim() === ""
      ? null
      : String(storeRaw).trim().slice(0, 120);
  const dateRaw = data.date ?? null;
  const date =
    dateRaw != null && /^\d{4}-\d{2}-\d{2}$/.test(String(dateRaw).trim())
      ? String(dateRaw).trim()
      : null;
  const totalRaw = Number(data.totalAmount ?? data.total ?? NaN);
  const totalAmount = Number.isFinite(totalRaw) && totalRaw > 0 ? Math.round(totalRaw) : null;
  const taxRaw = Number(data.taxAmount ?? data.consumptionTax ?? data.tax ?? NaN);
  const taxAmount = Number.isFinite(taxRaw) && taxRaw >= 0 ? Math.round(taxRaw) : null;
  const srcItems = Array.isArray(data.items) ? data.items : [];
  const items = srcItems
    .map((x) => {
      const name = String(x?.name ?? x?.itemName ?? "").trim();
      const unitRaw = Number(x?.unitPrice ?? x?.price ?? x?.amount ?? NaN);
      const unitPrice = Number.isFinite(unitRaw) && unitRaw >= 0 ? Math.round(unitRaw) : null;
      const categoryRaw = String(x?.category ?? "").trim();
      const category = allowedItemCategories.has(categoryRaw) ? categoryRaw : "その他";
      if (!name && unitPrice == null) return null;
      return { name: name || "（品目）", unitPrice, category };
    })
    .filter(Boolean)
    .slice(0, 120);
  const mainCategoryRaw = String(data.mainCategory ?? "").trim();
  const mainCategory = allowedItemCategories.has(mainCategoryRaw)
    ? mainCategoryRaw
    : inferMainCategoryFromItems(items);
  return { storeName, date, totalAmount, taxAmount, items, mainCategory };
}

function inferMainCategoryFromItems(items) {
  const score = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    const cat = String(it?.category ?? "").trim() || "その他";
    const p = Number(it?.unitPrice ?? NaN);
    const add = Number.isFinite(p) && p > 0 ? p : 1;
    score.set(cat, (score.get(cat) ?? 0) + add);
  }
  let best = "その他";
  let bestValue = -1;
  for (const [cat, v] of score.entries()) {
    if (v > bestValue) {
      bestValue = v;
      best = cat;
    }
  }
  return best;
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
/** 支出カテゴリを {id, name} または 文字列 から、トークン節約用の [id, 名前][] に正規化 */
function buildExpenseCategoryTuplesForPrompt(categoryCandidates) {
  const tuples = [];
  for (const x of Array.isArray(categoryCandidates) ? categoryCandidates : []) {
    if (x != null && typeof x === "object" && x.name != null) {
      const name = String(x.name ?? "").trim();
      if (!name) continue;
      const idNum = x.id != null && Number.isFinite(Number(x.id)) ? Number(x.id) : null;
      tuples.push(idNum == null ? [null, name] : [idNum, name]);
    } else {
      const name = String(x ?? "").trim();
      if (name) tuples.push([null, name]);
    }
  }
  return tuples;
}

function buildReceiptAiPromptBundle(opts) {
  const subscriptionActive = Boolean(opts.subscriptionActive);
  const summary = opts.summary;
  const items = opts.items;
  const ocrLines = opts.ocrLines;
  const categoryCandidates = opts.categoryCandidates;
  const expenseCategoryTuples = buildExpenseCategoryTuplesForPrompt(categoryCandidates);
  const historyHints = opts.historyHints;
  const heuristic = opts.heuristicCategorySuggestion ?? null;
  const memoCategoryPairs = Array.isArray(opts.memoCategoryPairs) ? opts.memoCategoryPairs : [];
  const vendorOcrKeyHints = Array.isArray(opts.vendorOcrKeyHints) ? opts.vendorOcrKeyHints : [];
  const rawOcrText = typeof opts.rawOcrText === "string" ? opts.rawOcrText : "";

  if (!subscriptionActive) {
    const systemPrompt =
      'JSON {"vendorName":null,"date":"","totalAmount":0,"categoryName":null,"reason":""} のみ返す。JSON以外のテキストは1文字も出力するな。挨拶・説明・Markdown禁止。dateはYYYY-MM-DD、不明はnull。';

    const auxPayload = {
      ocrLines,
      note: "ocrLines のみ（画像由来の生テキスト行）。",
    };

    const userTextPrompt = JSON.stringify({ ocrLines: auxPayload.ocrLines });

    return { systemPrompt, userTextPrompt, receiptAiTier: "free" };
  }

  const catLine =
    expenseCategoryTuples.length > 0
      ? `【支出カテゴリ】expenseCategoryTuples = [id|null, 名前] の配列: ${JSON.stringify(
          expenseCategoryTuples,
        )}。categoryName には 名前 だけ（上記のいずれか1つ）か null。id は出さない。`
      : "（支出カテゴリ一覧なし。一般名で null 可）";

  const vHint =
    vendorOcrKeyHints.length > 0
      ? `vendorOcrKeyHints（学習済み 店名表記→カテゴリ）: ${JSON.stringify(
          vendorOcrKeyHints,
        )}。OCR 表記と合うなら categoryName を最優先で一致。`
      : "vendorOcrKeyHints は空。";

  const systemPrompt = [
    'JSON {"vendorName":"","date":"","totalAmount":0,"taxAmount":0,"lineItems":[],"categoryName":"","reason":""} のみ返す。',
    "JSON以外のテキストは1文字も出力するな。",
    "挨拶・説明・Markdown禁止。dateはYYYY-MM-DD。不明はnull。",
    "lineItemsは[{name,amount|null}]。categoryNameは候補名1つまたはnull。",
    catLine,
    vHint,
  ].join("\n");

  const auxPayload = {
    summary,
    items,
    ocrLines: Array.isArray(ocrLines) ? ocrLines.slice(0, 80) : [],
    expenseCategoryTuples,
    historyHints: Array.isArray(historyHints) ? historyHints.slice(0, 12) : [],
    memoCategoryPairs: Array.isArray(memoCategoryPairs) ? memoCategoryPairs.slice(0, 12) : [],
    vendorOcrKeyHints: Array.isArray(vendorOcrKeyHints) ? vendorOcrKeyHints.slice(0, 12) : [],
    heuristicCategorySuggestion: heuristic,
  };

  const userTextPrompt = JSON.stringify(auxPayload);

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
  const t0 = Date.now();
  const summary = input?.summary && typeof input.summary === "object" ? input.summary : {};
  const items = Array.isArray(input?.items) ? input.items : [];
  const ocrLines = Array.isArray(input?.ocrLines) ? input.ocrLines : [];
  const categoryCandidates = Array.isArray(input?.categoryCandidates) ? input.categoryCandidates : [];
  const historyHints = Array.isArray(input?.historyHints) ? input.historyHints : [];
  const memoCategoryPairs = Array.isArray(input?.memoCategoryPairs) ? input.memoCategoryPairs : [];
  const vendorOcrKeyHints = Array.isArray(input?.vendorOcrKeyHints) ? input.vendorOcrKeyHints : [];
  const rawOcrText = Array.isArray(ocrLines) ? ocrLines.join("\n") : "";
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
    memoCategoryPairs,
    vendorOcrKeyHints,
    rawOcrText,
    heuristicCategorySuggestion,
  });

  let rawReply = "";
  let receiptAiSource = "text";

  const receiptVisionEnabled = false;
  if (receiptVisionEnabled && imageBase64 && imageBase64.trim()) {
    const vis = await invokeBedrockReceiptVision({
      systemPrompt,
      textPrompt: userTextPrompt,
      imageBase64,
      mediaType: imageMediaType,
      maxTokens: 220,
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
    const region = String(process.env.BEDROCK_REGION || process.env.AWS_REGION || DEFAULT_REGION).trim() || DEFAULT_REGION;
    const out = await invokeBedrockText({
      systemPrompt,
      userPrompt: textOnlyPrompt,
      maxTokens: 220,
      temperature: 0.05,
      modelCandidates: fastReceiptModelCandidates(region),
      logContext: "bedrock.text.receipt_assist",
    });
    if (!out?.ok) {
      logger.warn("receipt_assist_text_fail", {
        durationMs: Date.now() - t0,
        code: out?.code,
        authFailed: out?.authFailed,
        throttled: out?.throttled,
      });
      return out;
    }
    rawReply = out.reply;
  }

  const parsed = parseJsonBlock(rawReply);
  const data = normalizeReceiptAiPayload(parsed);
  if (!data) {
    logger.warn("receipt_assist_json_invalid", { durationMs: Date.now() - t0, receiptAiSource });
    return { ok: false, code: "InvalidModelJson", message: "Receipt AI JSON parse failed" };
  }
  logger.info("receipt_assist_complete", {
    durationMs: Date.now() - t0,
    receiptAiSource,
    receiptAiTier,
  });
  return { ok: true, data, receiptAiSource, receiptAiTier };
}

/**
 * Textract AnalyzeExpense の抽出結果を Claude に渡し、構造化 JSON（店名/日付/合計/品目）へ整形する。
 * @param {object} input
 * @param {Record<string, unknown>} [input.textract]
 */
export async function askBedrockHybridReceiptFromTextract(input = {}) {
  const textract = input?.textract && typeof input.textract === "object" ? input.textract : {};
  const systemPrompt = "レシートの合計金額、店名、日付のみをJSONで返せ。説明不要。";
  const textLines = [];
  if (Array.isArray(textract.ocrLines)) {
    for (const line of textract.ocrLines) {
      const s = String(line ?? "").trim();
      if (s) textLines.push(s);
    }
  }
  if (textLines.length === 0 && textract.summary && typeof textract.summary === "object") {
    for (const v of Object.values(textract.summary)) {
      const s = String(v ?? "").trim();
      if (s) textLines.push(s);
    }
  }
  if (textLines.length === 0 && Array.isArray(textract.items)) {
    for (const row of textract.items) {
      const name = String(row?.name ?? "").trim();
      const amount = row?.amount != null ? String(row.amount).trim() : "";
      const joined = [name, amount].filter(Boolean).join(" ");
      if (joined) textLines.push(joined);
    }
  }
  const textractText = textLines.join("\n").slice(0, 12000);
  const userPrompt = `レシートの合計金額、店名、日付のみをJSONで返せ。説明不要。\n${textractText || "(empty)"}`;
  const out = await invokeBedrockText({
    systemPrompt,
    userPrompt,
    maxTokens: 120,
    temperature: 0.05,
    modelCandidates: fastReceiptModelCandidates(
      String(process.env.BEDROCK_REGION || process.env.AWS_REGION || DEFAULT_REGION).trim() || DEFAULT_REGION,
    ),
    logContext: "bedrock.text.textract_hybrid",
  });
  if (!out?.ok) return out;
  const parsed = parseJsonBlock(out.reply);
  const data = normalizeHybridReceiptPayload(parsed);
  if (!data) {
    return { ok: false, code: "InvalidHybridJson", message: "Hybrid receipt JSON parse failed" };
  }
  return { ok: true, data };
}
