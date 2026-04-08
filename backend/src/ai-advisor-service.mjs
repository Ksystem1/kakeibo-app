import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

const DEFAULT_REGION = "us-east-1";
const DEFAULT_MODEL_ID = "us.anthropic.claude-sonnet-4-6";

function getBedrockConfig() {
  const region = String(process.env.BEDROCK_REGION || DEFAULT_REGION).trim() || DEFAULT_REGION;
  const modelId = String(process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID).trim();
  return { region, modelId };
}

function buildPrompt(message, context) {
  const systemPrompt = [
    "あなたはプロの家計再生コンサルタントです。",
    "ユーザーの支出データ（現在はデモデータで可）に基づき、具体的かつポジティブな節約案を提案してください。",
    "質問文に必ず直接回答してください。質問と無関係な一般論だけを返してはいけません。",
    "可能なら金額やカテゴリ名を入れて提案してください。",
    "回答は3行以内で、インスタ映えする絵文字を適度に使ってください。",
  ].join("\n");
  const userPrompt = [
    `ユーザー質問: ${message}`,
    `対象月: ${context?.yearMonth ?? "不明"}`,
    `収入合計: ${Number(context?.incomeTotal ?? 0)}円`,
    `支出合計: ${Number(context?.expenseTotal ?? 0)}円`,
    `上位カテゴリ: ${JSON.stringify(context?.topCategories ?? [])}`,
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
  return { code, message, throttled, authFailed };
}

function parseClaudeText(data) {
  const content = Array.isArray(data?.content) ? data.content : [];
  const texts = content
    .filter((x) => x && x.type === "text" && typeof x.text === "string")
    .map((x) => String(x.text).trim())
    .filter(Boolean);
  return texts.join("\n").trim();
}

async function invokeBedrockText({ systemPrompt, userPrompt, maxTokens = 300, temperature = 0.4 }) {
  const { region, modelId } = getBedrockConfig();
  if (!modelId) return null;
  const client = new BedrockRuntimeClient({ region });

  const body = JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: maxTokens,
    temperature,
    system: systemPrompt,
    messages: [{ role: "user", content: [{ type: "text", text: userPrompt }] }],
  });

  try {
    const cmd = new InvokeModelCommand({
      modelId,
      contentType: "application/json",
      accept: "application/json",
      body,
    });
    const res = await client.send(cmd);
    const raw = Buffer.from(res.body ?? new Uint8Array()).toString("utf-8");
    const data = JSON.parse(raw || "{}");
    const reply = parseClaudeText(data);
    if (!reply) return null;
    return { ok: true, reply };
  } catch (e) {
    return { ok: false, ...mapAwsError(e) };
  }
}

export async function askBedrockAdvisor(message, context) {
  const { systemPrompt, userPrompt } = buildPrompt(message, context);
  return invokeBedrockText({ systemPrompt, userPrompt, maxTokens: 300, temperature: 0.4 });
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
