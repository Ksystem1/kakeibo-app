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
  const remaining = Math.max(0, Math.round(income - expense));
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
    "残り予算・あといくら・使える金額と聞かれたら、必ず与えられた「残金」の数値だけを使い、他の金額と矛盾させないでください。",
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
    `支出合計: ${expense.toLocaleString("ja-JP")}円`,
    `残金（収入−支出、負のときは0）: ${remaining.toLocaleString("ja-JP")}円`,
    `支出カテゴリ上位（要約）: ${topReadable || "（データなし）"}`,
    `支出カテゴリ上位（機械可読・多い順）: ${JSON.stringify(top.slice(0, 10))}`,
    `直近会話: ${JSON.stringify(history)}`,
    "---",
    `ユーザー質問: ${message}`,
  ].join("\n");
  return { systemPrompt, userPrompt };
}

function mapAwsError(e) {
  const code = String(e?.name || e?.Code || "BedrockError");
  const message = String(e?.message || "Bedrock invoke_model failed");
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
      code: "NoBedrockConfig",
      message: "No Bedrock model candidates (region misconfigured?)",
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

export async function askBedrockReceiptAssistant(input) {
  const systemPrompt = [
    "あなたは家計簿アプリのレシート読取補助AIです。",
    "OCRで崩れた店舗名・日付・合計金額を補正し、最適な支出カテゴリを提案してください。",
    "必ずJSONのみを返してください。説明文は不要です。",
  ].join("\n");
  const userPrompt = [
    "次の情報から補正してください。",
    "ocrLines にはレシートから抽出した生テキスト行が含まれます。summary/itemsより優先して文脈判断に使ってください。",
    JSON.stringify(input),
    "出力JSONスキーマ:",
    '{"vendorName":"string|null","date":"YYYY-MM-DD|null","totalAmount":number|null,"categoryName":"string|null","reason":"string"}',
  ].join("\n");
  const out = await invokeBedrockText({
    systemPrompt,
    userPrompt,
    maxTokens: 260,
    temperature: 0.2,
  });
  if (!out?.ok) return out;
  const data = parseJsonBlock(out.reply);
  if (!data || typeof data !== "object") {
    return { ok: false, code: "InvalidModelJson", message: "Receipt AI JSON parse failed" };
  }
  return { ok: true, data };
}
