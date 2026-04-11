import {
  BedrockRuntimeClient,
  ConverseCommand,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { createLogger } from "./logger.mjs";

const logger = createLogger("bedrock");

const DEFAULT_REGION = "ap-northeast-1";
/**
 * オンデマンドで基盤モデル ID 直指定が拒否されるリージョンでは、
 * システム定義の推論プロファイル ID（地域プレフィックス付き）が必要。
 * @see https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html
 */
function inferenceProfileCandidatesForRegion(region) {
  const r = String(region || DEFAULT_REGION).toLowerCase().trim() || DEFAULT_REGION;
  let geo = "us";
  if (r.startsWith("eu-")) geo = "eu";
  else if (r.startsWith("ap-")) geo = "apac";
  else if (r.startsWith("us-") || r.startsWith("ca-") || r.startsWith("mx-")) geo = "us";
  else if (r.startsWith("sa-")) geo = "us";

  // Claude 3.5 はクロスリージョン推論プロファイル（東京=apac.*）がオンデマンドで安定。
  // anthropic.claude-sonnet-4-* の基盤モデル ID 直指定は多くのリージョンで on-demand 非対応のため候補に含めない。
  return [
    `${geo}.anthropic.claude-3-5-sonnet-20240620-v1:0`,
    `${geo}.anthropic.claude-3-5-haiku-20241022-v1:0`,
  ];
}

/** レガシー: まだ基盤モデル ID のオンデマンドが通る環境向け（3.5系のみ） */
const LEGACY_FOUNDATION_MODEL_IDS = [
  "anthropic.claude-3-5-sonnet-20240620-v1:0",
  "anthropic.claude-3-5-haiku-20241022-v1:0",
];

function getBedrockConfig() {
  const region =
    String(process.env.BEDROCK_REGION || process.env.AWS_REGION || DEFAULT_REGION).trim() ||
    DEFAULT_REGION;
  const explicit = String(process.env.BEDROCK_MODEL_ID || "").trim();
  const profiles = inferenceProfileCandidatesForRegion(region);
  const candidates = [...(explicit ? [explicit] : []), ...profiles, ...LEGACY_FOUNDATION_MODEL_IDS]
    .map((x) => String(x || "").trim())
    .filter(Boolean)
    .filter((x, i, arr) => arr.indexOf(x) === i);
  const modelId = explicit || profiles[0] || LEGACY_FOUNDATION_MODEL_IDS[0];
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
  const systemPrompt = [
    "あなたはプロの家計再生コンサルタントです。",
    "直後に与える「収入合計」「支出合計」「残金」「上位カテゴリ」は、このユーザーの家計簿から集計した事実です。",
    "金額・カテゴリ別の数値は、与えられたフィールドに明示されているものだけを引用してください。推測・例示・創作の金額は禁止です。",
    "「固定費」など、上位カテゴリのJSONに無いラベルに対する具体額は出さないでください。その場合はカテゴリ名をユーザーに確認するか、与えられたカテゴリ名だけを使ってください。",
    "残り予算・あといくら・使える金額と聞かれたら、必ず与えられた「残金」の数値だけを使い、他の金額と矛盾させないでください。",
    "質問文に必ず直接回答してください。質問と無関係な一般論だけを返してはいけません。",
    "1行目は質問への直接回答（結論）にしてください。質問のキーワードを1つ以上そのまま含めてください。",
    "質問が「あといくら」「残り」「使える金額」なら、必ず上記の残金（円）を明示してください。",
    "質問がカテゴリや節約方法なら、対象カテゴリ名を明示して答えてください。",
    "回答は質問への結論を最初の1文で示し、その後に根拠や実行案を述べてください。",
    "会話履歴がある場合は、直近の質問意図を優先し、文脈と矛盾しない回答にしてください。",
    "回答は3行以内で、絵文字は適度に使ってください。",
  ].join("\n");
  const userPrompt = [
    `ユーザー質問: ${message}`,
    `対象月: ${context?.yearMonth ?? "不明"}`,
    `収入合計: ${income}円`,
    `支出合計: ${expense}円`,
    `残金（収入合計−支出合計、負のときは0）: ${remaining}円`,
    `上位カテゴリ（支出、多い順）: ${JSON.stringify(context?.topCategories ?? [])}`,
    `直近会話: ${JSON.stringify(history)}`,
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
    const cmd = new InvokeModelCommand({
      modelId,
      contentType: "application/json",
      accept: "application/json",
      body,
    });
    const res = await client.send(cmd);
    const raw = Buffer.from(res.body ?? new Uint8Array()).toString("utf-8");
    const data = JSON.parse(raw || "{}");
    return parseClaudeInvokeText(data);
  }, `invoke:${label}:${modelId}`);
}

async function tryConverse(client, modelId, systemPrompt, userPrompt, maxTokens, temperature) {
  return withThrottleRetry(async () => {
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
    return parseConverseAssistantText(res);
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
