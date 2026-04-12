/**
 * App Runner / 本番の既定エントリ（package.json の npm start）。
 * HTTP サーバー実装は scripts/local-server.mjs。
 *
 * load-env を最優先: .env を app-core より先に読み込む。
 */
import "./load-env.mjs";
import "../scripts/local-server.mjs";
