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

const MACHINE_ERROR_KINDS: Record<string, string> = {
  parse_error:
    "解析に失敗しました。複数のレシートが同じ写真に写っていると失敗しやすいです。1枚ずつ、または1件に切り抜いてから再度お試しください。",
  parse_http_error: "解析サービスがエラーを返しました。しばらくして再度お試しください。",
  run_exception: "解析処理中に障害が発生しました。しばらくして再度お試しください。",
  missing_request: "取込依頼の内容を読み取れませんでした。",
  null_top_level: "解析結果の形式が正しくありません。",
  empty_response_body: "解析応答が空でした。",
  empty_response: "解析応答が空でした。",
  invalid_json: "解析結果の形式が正しくありません。",
  not_json_object: "解析結果の形式が正しくありません。",
  unexpected_type: "解析結果の形式が正しくありません。",
  serialize_failed: "解析結果の正規化に失敗しました。",
  serialize_roundtrip: "解析結果の保存形式に失敗しました。",
  serialize_error: "解析結果の保存形式に失敗しました。",
};

function isMachineOnlyErrorCode(s: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(s) && s.length < 48;
}

/** キュー行に表示するユーザー向け短文 */
export function formatReceiptQueueFailureMessage(
  errorMessage: string | null | undefined,
  result: unknown,
): string {
  if (errorMessage && String(errorMessage).trim()) {
    const s = String(errorMessage);
    if (MACHINE_ERROR_KINDS[s]) return MACHINE_ERROR_KINDS[s]!;
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
    if (typeof o.error === "string" && o.error.trim()) {
      const e = o.error.trim();
      if (MACHINE_ERROR_KINDS[e]) return MACHINE_ERROR_KINDS[e]!;
      if (isMachineOnlyErrorCode(e)) {
        return MACHINE_ERROR_KINDS.parse_error!;
      }
      return e;
    }
  }
  return "解析に失敗しました。写真を手で撮り直すか、金額・日付を手入力できます。";
}
