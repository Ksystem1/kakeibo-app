type DecodeCandidate = {
  encoding: "utf-8" | "shift_jis";
  text: string;
  score: number;
};

function scoreDecodedText(text: string): number {
  if (!text) return -1000;
  let score = 0;
  const replacement = (text.match(/\uFFFD/g) ?? []).length;
  score -= replacement * 8;
  if (/�/.test(text)) score -= 15;
  if (/縺|繧|譛|蝣|蜿|ｿ|�/.test(text)) score -= 18;
  if (/[ぁ-んァ-ヶ一-龯]/.test(text)) score += 12;
  if (/利用日|取引日|摘要|金額|支払|加盟店|内容|明細|カテゴリ/.test(text)) score += 16;
  if (/[\x00-\x08\x0E-\x1F]/.test(text)) score -= 20;
  return score;
}

function decode(bytes: Uint8Array, encoding: "utf-8" | "shift_jis"): DecodeCandidate {
  const decoder = new TextDecoder(encoding, { fatal: false });
  const text = decoder.decode(bytes);
  return { encoding, text, score: scoreDecodedText(text) };
}

/**
 * CSV/TXT の文字コードを UTF-8 / Shift-JIS から推定して返す。
 * 日本語 CSV の文字化け（cp932 系）を優先的に回避する。
 */
export async function readFileTextAutoEncoding(file: File): Promise<{
  text: string;
  encoding: "utf-8" | "shift_jis";
}> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const utf8 = decode(bytes, "utf-8");
  const sjis = decode(bytes, "shift_jis");
  const best = sjis.score > utf8.score ? sjis : utf8;
  return { text: best.text, encoding: best.encoding };
}
