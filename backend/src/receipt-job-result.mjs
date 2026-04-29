/**
 * 非同期レシートジョブ: MySQL `result_data` (JSON) に入れる前の正規化。
 * JSON.parse のトップがオブジェクトでない / mysql2 への不適切な型渡し による
 * "Invalid JSON text" を防ぐ。
 */

const SCHEMA = "receipt_job_v1";
const MAX_RAW = 20_000;
const MAX_DEPTH = 32;
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function sanitizeText(s) {
  return String(s).replace(CONTROL_CHARS_RE, "");
}

/**
 * Bedrock/HTTP 応答に混じる markdown fence や前置きを落として
 * JSON.parse 可能性を上げる。
 * @param {string} raw
 * @returns {string}
 */
export function sanitizeReceiptJsonLikeRaw(raw) {
  let s = sanitizeText(raw ?? "").trim();
  s = s.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const firstObj = s.indexOf("{");
  const lastObj = s.lastIndexOf("}");
  if (firstObj >= 0 && lastObj > firstObj) {
    return s.slice(firstObj, lastObj + 1).trim();
  }
  const firstArr = s.indexOf("[");
  const lastArr = s.lastIndexOf("]");
  if (firstArr >= 0 && lastArr > firstArr) {
    return s.slice(firstArr, lastArr + 1).trim();
  }
  return s;
}

/**
 * @param {unknown} obj
 * @param {number} depth
 * @returns {unknown}
 */
function toJsonSafeValue(obj, depth) {
  if (depth > MAX_DEPTH) {
    return null;
  }
  if (obj === null) return null;
  const t = typeof obj;
  if (t === "string") {
    const cleaned = sanitizeText(obj);
    return cleaned.length > 50000 ? cleaned.slice(0, 50000) : cleaned;
  }
  if (t === "boolean") return obj;
  if (t === "number") {
    if (!Number.isFinite(obj) || Object.is(obj, -0)) return null;
    return obj;
  }
  if (t === "bigint") return String(obj);
  if (t === "undefined" || t === "function" || t === "symbol") {
    return undefined;
  }
  if (obj instanceof Date) {
    try {
      return obj.toISOString();
    } catch {
      return null;
    }
  }
  if (Array.isArray(obj)) {
    return obj
      .slice(0, 2000)
      .map((x) => toJsonSafeValue(x, depth + 1))
      .filter((x) => x !== undefined);
  }
  if (t === "object") {
    const out = {};
    for (const k of Object.keys(obj)) {
      if (k.length > 400) continue;
      const v = obj[k];
      if (v === undefined) continue;
      const nv = toJsonSafeValue(v, depth + 1);
      if (nv !== undefined) {
        out[k] = nv;
      }
    }
    return out;
  }
  return { _t: t, v: String(obj) };
}

function finalJsonObject(obj) {
  const s = JSON.stringify(obj);
  if (!s) return null;
  return JSON.parse(s);
}

/**
 * /receipts/parse 相当の HTTP 応答 body（文字列）から、result_data 用のオブジェクトとジョブ状態を導出する。
 * @param {string} rawBody
 * @returns {{ status: 'completed' | 'failed', resultData: Record<string, unknown> }}
 */
export function buildAsyncReceiptJobResultFromHttpBody(rawBody) {
  const raw = sanitizeReceiptJsonLikeRaw(rawBody);
  if (!raw.trim()) {
    return {
      status: "failed",
      resultData: {
        _schema: SCHEMA,
        error: "empty_response_body",
        message: "解析応答が空でした。",
        rawText: "",
      },
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      status: "failed",
      resultData: {
        _schema: SCHEMA,
        error: "invalid_json",
        message: msg,
        rawText: raw.slice(0, MAX_RAW),
      },
    };
  }

  if (parsed === null) {
    return {
      status: "failed",
      resultData: {
        _schema: SCHEMA,
        error: "null_top_level",
        message: "解析 API の戻りが空でした。",
        rawText: "",
      },
    };
  }

  const typ = typeof parsed;
  if (typ === "string" || typ === "number" || typ === "boolean" || typ === "bigint") {
    return {
      status: "failed",
      resultData: {
        _schema: SCHEMA,
        error: "not_json_object",
        message: "API の top-level がJSONオブジェクトではありません。",
        primitive: typ,
        valuePreview: typ === "string" ? String(parsed).slice(0, 800) : String(parsed).slice(0, 200),
        rawText: raw.slice(0, MAX_RAW),
      },
    };
  }

  if (Array.isArray(parsed)) {
    return {
      status: "failed",
      resultData: {
        _schema: SCHEMA,
        error: "not_json_object",
        message: "API の top-level が配列です。",
        rawText: raw.slice(0, MAX_RAW),
      },
    };
  }

  if (typ !== "object") {
    return {
      status: "failed",
      resultData: { _schema: SCHEMA, error: "unexpected_type", rawText: raw.slice(0, 2000) },
    };
  }

  let safe;
  try {
    const t = toJsonSafeValue(parsed, 0);
    if (t == null || typeof t !== "object" || Array.isArray(t)) {
      return {
        status: "failed",
        resultData: {
          _schema: SCHEMA,
          error: "serialize_failed",
          message: "結果を正規化できませんでした。",
          rawText: raw.slice(0, 8000),
        },
      };
    }
    safe = finalJsonObject(t);
    if (safe == null || typeof safe !== "object" || Array.isArray(safe)) {
      return {
        status: "failed",
        resultData: {
          _schema: SCHEMA,
          error: "serialize_roundtrip",
          message: "結果のJSON化に失敗しました。",
          rawText: raw.slice(0, 8000),
        },
      };
    }
  } catch (e) {
    return {
      status: "failed",
      resultData: {
        _schema: SCHEMA,
        error: "serialize_error",
        message: e instanceof Error ? e.message : String(e),
        rawText: raw.slice(0, 8000),
      },
    };
  }

  return { status: "completed", resultData: /** @type {Record<string, unknown>} */ (safe) };
}

/**
 * HTTP エラーや実行例外用の result_data
 * @param {object} p
 * @param {string} p.kind
 * @param {string} p.message
 * @param {string} [p.rawText]
 * @param {number} [p.httpStatus]
 * @param {string} [p.apiDetail]
 * @param {string} [p.apiCode]
 * @returns {Record<string, unknown>}
 */
export function buildReceiptJobErrorData(p) {
  return {
    _schema: SCHEMA,
    error: p.kind,
    message: p.message,
    rawText: (p.rawText ?? "").slice(0, MAX_RAW),
    httpStatus: p.httpStatus != null ? p.httpStatus : null,
    apiCode: p.apiCode ?? null,
    apiDetail: p.apiDetail != null ? String(p.apiDetail).slice(0, 2000) : null,
  };
}

/**
 * ジョブ行の `error_message` 用。`message` を優先し、空のときは `error` 種別から短文を出す
 *（DB が NULL になり画面が `parse_error` だけ出すのを防ぐ）。
 * @param {Record<string, unknown> | null | undefined} resultData
 * @returns {string}
 */
export function receiptJobUserFacingErrorLine(resultData) {
  if (resultData == null || typeof resultData !== "object" || Array.isArray(resultData)) {
    return "解析に失敗しました。写メのやり直し、または手入力をお試しください。";
  }
  const m = resultData.message != null ? String(resultData.message).trim() : "";
  if (m) return m.length > 4000 ? m.slice(0, 4000) : m;
  const k = resultData.error != null ? String(resultData.error).trim() : "";
  if (!k) {
    return "解析に失敗しました。写メのやり直し、または手入力をお試しください。";
  }
  const map = {
    parse_error: "解析結果の処理に失敗しました。レシートは1枚ずつ、はっきり写るように撮影して再度お試しください。",
    parse_http_error: "解析 API がエラーを返しました。しばらくしてから再度お試しください。",
    run_exception: "解析処理中に障害が発生しました。しばらくしてから再度お試しください。",
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
  if (k in map) return map[k];
  if (k.length <= 50 && /^[a-z0-9_]+$/i.test(k)) {
    return map.parse_error;
  }
  return k.length > 4000 ? k.slice(0, 4000) : k;
}

/**
 * MySQL JSON カラムにバインドする直前に必ず safe 化（プレーンレコードのみ）。
 * @param {Record<string, unknown>|null|undefined} obj
 * @returns {string}
 */
export function receiptJobResultDataToJsonStringForMysql(obj) {
  const o = obj == null || typeof obj !== "object" ? { _schema: SCHEMA, error: "not_object" } : obj;
  const t = toJsonSafeValue({ ...o }, 0);
  if (t == null || typeof t !== "object" || Array.isArray(t)) {
    return JSON.stringify({
      _schema: SCHEMA,
      error: "to_mysql_shape_failed",
      message: "ジョブ結果の整形に失敗しました。",
    });
  }
  return JSON.stringify(t);
}

/** mysql2 の JSON 型バインド用（中身は常に非プリミティブ top-level ではない: 一貫性のため再度 parse） */
export function receiptJobResultDataForMysqlBinding(obj) {
  return JSON.parse(receiptJobResultDataToJsonStringForMysql(obj));
}

export { SCHEMA as RECEIPT_JOB_RESULT_SCHEMA_V1 };
