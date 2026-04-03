/**
 * main ブランチで、作業ツリーがクリーンかつ origin/main と同一コミットか検証する。
 *
 *   npm run verify:git-sync
 *
 * オフライン時は fetch に失敗しても続行し、最後の fetch 時点の origin と比較する。
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

function sh(cmd) {
  return execSync(cmd, {
    encoding: "utf8",
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function shQuiet(cmd) {
  try {
    return sh(cmd);
  } catch {
    return null;
  }
}

let fetchWarn = false;
try {
  execSync("git fetch origin", {
    encoding: "utf8",
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
} catch {
  fetchWarn = true;
  console.error(
    "[verify:git-sync] 警告: git fetch に失敗しました（オフライン等）。origin の比較は最後に成功した時点の参照です。\n",
  );
}

const branch = sh("git rev-parse --abbrev-ref HEAD");
if (branch !== "main") {
  console.error(
    `[verify:git-sync] スキップ: 現在のブランチは "${branch}" です（main のときのみ厳密チェック）。`,
  );
  process.exit(0);
}

const porcelain = sh("git status --porcelain");
if (porcelain.length > 0) {
  console.error(
    "[verify:git-sync] 未コミットの変更または未追跡ファイルがあります。git status を確認してください。\n",
  );
  console.error(porcelain);
  process.exit(1);
}

const head = sh("git rev-parse HEAD");
let originMain = shQuiet("git rev-parse origin/main");
if (!originMain) {
  console.error(
    "[verify:git-sync] origin/main が取得できません。git fetch origin 後に再実行してください。",
  );
  process.exit(1);
}

if (head !== originMain) {
  const ahead = shQuiet(`git rev-list --count origin/main..HEAD`);
  const behind = shQuiet(`git rev-list --count HEAD..origin/main`);
  console.error("[verify:git-sync] HEAD と origin/main が一致しません。");
  if (ahead && ahead !== "0") {
    console.error(`  ローカルが ${ahead} コミット先に進んでいます → git push origin main`);
  }
  if (behind && behind !== "0") {
    console.error(`  リモートが ${behind} コミット先に進んでいます → git pull（必要なら）`);
  }
  process.exit(1);
}

console.error(
  `[verify:git-sync] OK: main は origin/main (${head.slice(0, 7)}) と一致。作業ツリーもクリーンです。`,
);
if (fetchWarn) {
  console.error("（fetch は失敗しましたが、参照は利用可能でした）");
}
process.exit(0);
