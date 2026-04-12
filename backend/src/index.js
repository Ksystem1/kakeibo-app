/**
 * App Runner / 本番の既定エントリ（package.json の npm start）。
 * HTTP サーバー実装は scripts/local-server.mjs。
 *
 * 1) dotenv/config … 起動 cwd の .env
 * 2) load-env.mjs … backend/.env 等を明示パスで上書きマージ
 */
import "dotenv/config";
import "./load-env.mjs";
import "../scripts/local-server.mjs";
