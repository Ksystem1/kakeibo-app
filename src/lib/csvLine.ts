/** 1行分の簡易CSV（ダブルクオート対応） */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
        continue;
      }
      inQ = !inQ;
      continue;
    }
    if (!inQ && (c === "," || c === "\t")) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}
