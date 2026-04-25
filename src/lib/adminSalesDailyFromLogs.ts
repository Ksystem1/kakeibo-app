/**
 * 管理画面の明細と同じ行データから日次に足し上げる（GET .../daily-summary が
 * 404 のときのフォールバック用。明細 API は 500 件制限のため、件数多い期間は近似）
 */
type LogLine = {
  occurred_at: string;
  gross_amount: number;
  net_amount: number;
};

export type DailySummaryLine = {
  day_key: string;
  gross_total: number;
  fee_total: number;
  net_total: number;
  sales_count: number;
};

function occurredAtToDayKey(occurredAt: string): string {
  const s = String(occurredAt).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return s.slice(0, 10);
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "1970-01-01";
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" });
}

export function isApiRouteNotFoundError(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e ?? "")).trim();
  if (!m) return false;
  if (/not found/i.test(m)) return true;
  if (m === "404" || /\(404\)/.test(m) || /status:?\s*404/i.test(m)) return true;
  return false;
}

export function aggregateAdminSalesLogsByDay(logs: LogLine[]): DailySummaryLine[] {
  const m = new Map<string, { gross: number; fee: number; net: number; count: number }>();
  for (const r of logs) {
    const day = occurredAtToDayKey(r.occurred_at);
    const g = Number(r.gross_amount ?? 0);
    const n = Number(r.net_amount ?? 0);
    const prev = m.get(day) ?? { gross: 0, fee: 0, net: 0, count: 0 };
    prev.gross += g;
    prev.net += n;
    /** 明細行の gross / net から含意手数料（画面の列と同じ感覚） */
    prev.fee += g - n;
    prev.count += 1;
    m.set(day, prev);
  }
  const rows: DailySummaryLine[] = Array.from(m.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day_key, v]) => ({
      day_key,
      gross_total: v.gross,
      fee_total: v.fee,
      net_total: v.net,
      sales_count: v.count,
    }));
  return rows;
}
