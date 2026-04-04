/**
 * レシート OCR 等の日付文字列を YYYY-MM-DD に寄せる（失敗時は null）
 */
export function normalizeReceiptDateToYmd(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;

  s = s.replace(/[（(].*[)）]/g, "").trim();
  s = s.replace(/T.*$/i, "").replace(/\s+.*$/, "").trim();

  const rei = /令和\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/.exec(s);
  if (rei) {
    const y = 2018 + Number.parseInt(rei[1], 10);
    return `${y}-${rei[2].padStart(2, "0")}-${rei[3].padStart(2, "0")}`;
  }
  const hei = /平成\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/.exec(s);
  if (hei) {
    const y = 1988 + Number.parseInt(hei[1], 10);
    return `${y}-${hei[2].padStart(2, "0")}-${hei[3].padStart(2, "0")}`;
  }
  const sho = /昭和\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/.exec(s);
  if (sho) {
    const y = 1925 + Number.parseInt(sho[1], 10);
    return `${y}-${sho[2].padStart(2, "0")}-${sho[3].padStart(2, "0")}`;
  }

  const jp = /^(\d{4})年(\d{1,2})月(\d{1,2})日?/.exec(s);
  if (jp) {
    return `${jp[1]}-${jp[2].padStart(2, "0")}-${jp[3].padStart(2, "0")}`;
  }

  const isoLike = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (isoLike) {
    return `${isoLike[1]}-${isoLike[2].padStart(2, "0")}-${isoLike[3].padStart(2, "0")}`;
  }

  const us = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (us) {
    return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  }

  const mdY2 = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})$/.exec(s);
  if (mdY2) {
    const n = Number.parseInt(mdY2[3], 10);
    const y = n >= 70 ? 1900 + n : 2000 + n;
    return `${y}-${mdY2[1].padStart(2, "0")}-${mdY2[2].padStart(2, "0")}`;
  }

  return null;
}
