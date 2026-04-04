/**
 * リポジトリの現在の HEAD を git archive で ZIP 化する。
 * 出力: <リポジトリの親ディレクトリ>/YYYYMMDD_家計簿完成.zip
 * （追跡済みファイルのみ。node_modules / dist は含まない）
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const outDir = path.resolve(root, "..");

const now = new Date();
const y = now.getFullYear();
const m = String(now.getMonth() + 1).padStart(2, "0");
const d = String(now.getDate()).padStart(2, "0");
const fileName = `${y}${m}${d}_家計簿完成.zip`;
const outPath = path.join(outDir, fileName);

fs.mkdirSync(outDir, { recursive: true });

execFileSync(
  "git",
  ["archive", "--format=zip", "-o", outPath, "HEAD"],
  { cwd: root, stdio: "inherit" },
);

const stat = fs.statSync(outPath);
console.log(`[backup] wrote ${outPath} (${(stat.size / 1024 / 1024).toFixed(2)} MiB)`);
