/**
 * 学年グループ正規化のスモークテスト（手動: node scripts/verify-grade-group.mjs）
 * api.ts の normalizeGradeGroup と同じルールをミラーする。
 */
function normalizeGradeGroup(raw) {
  if (raw == null) return null;
  const s0 = String(raw).trim();
  const s = s0.replace(/[－ー―ｰ]/g, "-");
  const asciiDigits = s.replace(/[０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
  );
  if (s === "1-2" || s === "3-4" || s === "5-6") return s;
  if (asciiDigits === "1-2" || asciiDigits === "3-4" || asciiDigits === "5-6")
    return asciiDigits;
  if (s === "1-2年生" || s === "3-4年生" || s === "5-6年生") {
    if (s.startsWith("1-2")) return "1-2";
    if (s.startsWith("3-4")) return "3-4";
    return "5-6";
  }
  const single = asciiDigits.match(/(?:小学|小)?\s*([1-6])\s*(?:年|年生)?/);
  if (single) {
    const y = Number.parseInt(single[1], 10);
    if (y >= 1 && y <= 2) return "1-2";
    if (y >= 3 && y <= 4) return "3-4";
    if (y >= 5 && y <= 6) return "5-6";
  }
  return null;
}

const cases = [
  ["5-6", "5-6"],
  ["小学5年生", "5-6"],
  ["5年生", "5-6"],
  [5, "5-6"],
  ["3-4", "3-4"],
  ["小学2年", "1-2"],
  [null, null],
];

let failed = 0;
for (const [input, expected] of cases) {
  const got = normalizeGradeGroup(input);
  const ok = got === expected;
  if (!ok) {
    failed += 1;
    console.error("NG", { input, expected, got });
  } else {
    console.log("OK", String(input), "->", got);
  }
}
if (failed) {
  process.exit(1);
}
console.log("verify-grade-group: all passed");
