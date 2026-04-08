import "dotenv/config";
import { askBedrockAdvisor } from "../src/ai-advisor-service.mjs";

async function main() {
  const region = String(process.env.BEDROCK_REGION || "").trim();
  const modelId = String(process.env.BEDROCK_MODEL_ID || "").trim();
  if (!region || !modelId) {
    console.error(
      "Missing required envs. Set BEDROCK_REGION and BEDROCK_MODEL_ID in backend/.env first.",
    );
    process.exit(1);
  }

  const out = await askBedrockAdvisor("今月の食費を少し下げるコツを1つ教えてください。", {
    yearMonth: "2026-04",
    incomeTotal: 300000,
    expenseTotal: 180000,
    topCategories: [{ name: "食費", total: 55000 }],
  });

  if (!out?.ok) {
    console.error("Bedrock connection failed:", out);
    process.exit(1);
  }

  console.log("Bedrock connection OK");
  console.log("Model:", modelId);
  console.log("Reply:", out.reply);
}

main().catch((e) => {
  console.error("Bedrock test error:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
