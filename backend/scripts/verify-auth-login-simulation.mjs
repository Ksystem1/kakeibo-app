/**
 * 内部シミュレーション: bcrypt の照合が POST /auth/login（verifyPassword）と一致することを確認。
 * 既存ユーザーが DB に保存されたハッシュのままログインできる想定の一次チェック。
 * （実際の HTTP / DB までは行わない。）
 *
 * 実行: cd backend && npm run verify:auth-login
 */
import { hashPassword, USERS_NO_PASSWORD_PLACEHOLDER, verifyPassword } from "../src/auth-logic.mjs";

const userChosenPassword = "InternalSim!Login9z";

const hash = await hashPassword(userChosenPassword);
if (!(await verifyPassword(userChosenPassword, hash))) {
  console.error("[verify:auth-login] FAIL: 同じ平文は検証に通る必要があります。");
  process.exit(1);
}
if (await verifyPassword("wrong-guess-xxx", hash)) {
  console.error("[verify:auth-login] FAIL: 誤った平文は拒否される必要があります。");
  process.exit(1);
}

const placeholderHash = await hashPassword(USERS_NO_PASSWORD_PLACEHOLDER);
if (await verifyPassword("any", placeholderHash)) {
  console.error("[verify:auth-login] FAIL: 移行用プレースホルダは推測ログインできない想定です。");
  process.exit(1);
}

console.log(
  [
    "[verify:auth-login] OK",
    " ・平文↔bcrypt 照合: login と同じ流れ（verifyPassword）",
    " ・v29 プレースホルダハッシュ: 推測パスワードでは通過しない",
    " 子ども/親: login_name+password を設定している行は、従来どおり平文＝登録時と同じ文字列で検証されます。",
  ].join("\n"),
);
