/**
 * 家計定型フォールバックではなく Bedrock が動いているかの簡易検証。
 * 成功時の返答に「まずは固定費」だけが単独で返るパターンはサーバー側ルール応答の可能性が高い。
 *
 * 実行: cd backend && npm run test:bedrock:lucky
 * 要: backend/.env に BEDROCK_REGION（および必要なら BEDROCK_MODEL_ID）
 */
import "dotenv/config";
import { askBedrockAdvisor } from "../src/ai-advisor-service.mjs";

const LUCKY_Q = "今日のラッキー食材を教えて";
const RULE_LIKE = /まずは固定費（通信費・保険・サブスク）を見直し/;

async function main() {
  const region = String(process.env.BEDROCK_REGION || "").trim();
  if (!region) {
    console.error("Missing BEDROCK_REGION in backend/.env");
    process.exit(1);
  }

  const out = await askBedrockAdvisor(LUCKY_Q, {
    yearMonth: "2026-04",
    incomeTotal: 300000,
    expenseTotal: 180000,
    topCategories: [{ name: "食費", total: 55000 }],
  });

  if (!out?.ok) {
    console.error("Bedrock failed (not ok):", out);
    process.exit(1);
  }

  const text = String(out.reply ?? "").trim();
  console.log("Model:", out.modelId, "via:", out.via);
  console.log("Reply:\n", text);

  if (!text) {
    console.error("Empty reply");
    process.exit(1);
  }

  if (RULE_LIKE.test(text) && text.length < 120) {
    console.warn(
      "警告: 返答がサーバー側ルール応答の定型に酷似しています。Bedrock が失敗して API がフォールバックしている可能性を確認してください。",
    );
    process.exit(2);
  }

  console.log("\nOK: Bedrock から可変の本文が返っています（ルール定型のみとは判定しませんでした）。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
