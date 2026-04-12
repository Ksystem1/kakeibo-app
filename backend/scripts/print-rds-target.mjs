/**
 * backend/.env が指す RDS 接続先（パスワード除く）を表示する。
 * ECS / 手動 mysql と食い違いがないか比較用。
 *
 * 使い方: cd backend && node scripts/print-rds-target.mjs
 */
import "dotenv/config";

function main() {
  const host = String(process.env.RDS_HOST || "").trim();
  const port = String(process.env.RDS_PORT || "3306").trim();
  const user = String(process.env.RDS_USER || "").trim();
  const database = String(process.env.RDS_DATABASE || "").trim();
  const ssl = String(process.env.RDS_SSL || "").trim();

  console.log("[print-rds-target] backend/.env から読み取った接続先（パスワードは表示しません）");
  console.log(JSON.stringify({ RDS_HOST: host, RDS_PORT: port, RDS_USER: user, RDS_DATABASE: database, RDS_SSL: ssl || "(未設定)" }, null, 2));
  console.log(
    "[print-rds-target] mysql クライアント例（-p のあとにパスワード入力。DB は --database で指定）:",
  );
  console.log(
    `  mysql -h "${host}" -P ${port} -u "${user}" -p --database="${database}"`,
  );
}

main();
