/**
 * 新規登録・パスワード再設定・管理者による初期パスワード設定時のみ使用。
 * ログイン時は形式チェックをしない（既存ユーザーの旧形式パスワードを阻害しない）。
 *
 * ルール: 8〜128 文字、印字可能 ASCII のみ、英字・数字・記号（英数字以外）をそれぞれ1文字以上。
 */
const PRINTABLE_ASCII = /^[\x21-\x7E]+$/;

export function isValidNewPassword(pw: string): boolean {
  if (typeof pw !== "string") return false;
  if (pw.length < 8 || pw.length > 128) return false;
  if (!PRINTABLE_ASCII.test(pw)) return false;
  if (!/[a-zA-Z]/.test(pw)) return false;
  if (!/[0-9]/.test(pw)) return false;
  if (!/[^A-Za-z0-9]/.test(pw)) return false;
  return true;
}

/** フォームラベル・プレースホルダ用（ユーザー指定の短い表記） */
export const NEW_PASSWORD_LABEL = "英数字記号8文字以上";

/** ツールチップ等の補足 */
export const NEW_PASSWORD_TOOLTIP =
  "8文字以上で、英字（a〜z / A〜Z）・数字（0〜9）・記号（例: @ $ ! % * ? & など）をそれぞれ1文字以上含めてください。";

export const NEW_PASSWORD_ERROR_MESSAGE =
  "パスワードは英数字記号8文字以上としてください。英字・数字・記号をそれぞれ1文字以上含めてください。";
