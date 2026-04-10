import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

const DEFAULT_REGION = "ap-northeast-1";
const DEFAULT_MODEL_ID = "anthropic.claude-3-5-sonnet-20240620-v1:0";

function getBedrockConfig() {
  const region = String(process.env.BEDROCK_REGION || process.env.AWS_REGION || DEFAULT_REGION).trim() || DEFAULT_REGION;
  const modelId = String(process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID).trim();
  return { region, modelId };
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
  return invokeBedrockText({ systemPrompt, userPrompt, maxTokens: 320, temperature: 0.1 });
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
