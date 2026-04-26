import type { ParseReceiptResult } from "./api";

/**
 * 非同期ジョブ完了行からフォームに流す: `ok: true` の本解析レスポンスのときだけ true
 * （ジョブ用エラーレコード `_schema: receipt_job_v1` や曖昧な形は弾く）
 */
export function isSuccessfulReceiptJobApplyResult(r: unknown): r is ParseReceiptResult {
  if (r == null || typeof r !== "object" || Array.isArray(r)) return false;
  const o = r as { ok?: unknown; _schema?: string; error?: string; message?: string };
  if (o._schema === "receipt_job_v1" && o.error) return false;
  return o.ok === true;
}

/** キュー行に表示するユーザー向け短文 */
export function formatReceiptQueueFailureMessage(
  errorMessage: string | null | undefined,
  result: unknown,
): string {
  if (errorMessage && String(errorMessage).trim()) {
    const s = String(errorMessage);
    if (
      /Invalid JSON text|result_data|ER_INVALID/i.test(s) &&
      s.length > 80
    ) {
      return "解析結果の保存に失敗しました。写真を選び直すか、下のフォームに手入力できます。";
    }
    return s;
  }
  if (result != null && typeof result === "object" && !Array.isArray(result)) {
    const o = result as { message?: unknown; error?: unknown };
    if (typeof o.message === "string" && o.message.trim()) return o.message;
    if (typeof o.error === "string" && o.error.trim()) return o.error;
  }
  return "解析に失敗しました。写真を手で撮り直すか、金額・日付を手入力できます。";
}
