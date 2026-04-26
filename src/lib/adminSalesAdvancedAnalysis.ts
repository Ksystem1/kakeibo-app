import type { AdminSalesLogRow, AdminSalesMonthlySummaryRow } from "./api";

export type AdminSalesUserContribution = {
  userId: number | null;
  userLabel: string;
  net: number;
  ratio: number;
};

export type AdminSalesAdvancedAnalysis = {
  forecastMonthEndNet: number;
  trailing3MonthAverageNet: number;
  oneYearProjectedCumulativeNet: number;
  currentCumulativeNet: number;
  monthOverMonthPercent: number | null;
  monthOverMonthBaseYm: string | null;
  monthOverMonthTargetYm: string | null;
  userContribution: AdminSalesUserContribution[];
};

function parseYm(ym: string): { y: number; m: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym).trim());
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]) };
}

function daysInMonth(ym: string): number {
  const p = parseYm(ym);
  if (!p) return 30;
  return new Date(p.y, p.m, 0).getDate();
}

function prevYm(ym: string): string | null {
  const p = parseYm(ym);
  if (!p) return null;
  const d = new Date(p.y, p.m - 1, 1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function buildAdminSalesAdvancedAnalysis(params: {
  monthlySummary: AdminSalesMonthlySummaryRow[];
  salesLogs: AdminSalesLogRow[];
  selectedYm: string;
}): AdminSalesAdvancedAnalysis {
  const byYm = new Map<string, number>();
  for (const r of params.monthlySummary) {
    byYm.set(String(r.ym), Number(r.net_total ?? 0));
  }

  const sortedYm = Array.from(byYm.keys()).sort((a, b) => b.localeCompare(a));
  const targetYm = /^\d{4}-\d{2}$/.test(params.selectedYm)
    ? params.selectedYm
    : sortedYm[0] ?? null;
  const baseYm = targetYm ? prevYm(targetYm) : null;
  const targetNet = targetYm ? byYm.get(targetYm) ?? 0 : 0;
  const baseNet = baseYm ? byYm.get(baseYm) ?? null : null;
  const monthOverMonthPercent =
    baseNet != null && Math.abs(baseNet) > 0.0001
      ? ((targetNet - baseNet) / Math.abs(baseNet)) * 100
      : null;

  const trailing3 = sortedYm.slice(0, 3).map((ym) => ({
    ym,
    net: byYm.get(ym) ?? 0,
  }));
  const trailing3MonthAverageNet =
    trailing3.length > 0
      ? trailing3.reduce((s, x) => s + x.net, 0) / trailing3.length
      : 0;
  const avgDailyFrom3Months =
    trailing3.length > 0
      ? trailing3.reduce((s, x) => s + x.net / daysInMonth(x.ym), 0) / trailing3.length
      : 0;
  const now = new Date();
  const currentYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const forecastMonthEndNet = avgDailyFrom3Months * daysInMonth(currentYm);

  const currentCumulativeNet = params.monthlySummary.reduce(
    (s, r) => s + Number(r.net_total ?? 0),
    0,
  );
  const oneYearProjectedCumulativeNet = currentCumulativeNet + forecastMonthEndNet * 12;

  const byUser = new Map<string, { userId: number | null; userLabel: string; net: number }>();
  for (const r of params.salesLogs) {
    const id = r.user_id != null && Number.isFinite(Number(r.user_id)) ? Number(r.user_id) : null;
    const label =
      id != null
        ? String(r.user_email ?? "").trim() || `User#${id}`
        : String(r.family_name ?? "").trim() || "不明ユーザー";
    const key = id != null ? `u:${id}` : `x:${label}`;
    const prev = byUser.get(key) ?? { userId: id, userLabel: label, net: 0 };
    prev.net += Number(r.net_amount ?? 0);
    byUser.set(key, prev);
  }
  const totalUserNet = Array.from(byUser.values()).reduce((s, x) => s + x.net, 0);
  const userContribution: AdminSalesUserContribution[] = Array.from(byUser.values())
    .map((x) => ({
      userId: x.userId,
      userLabel: x.userLabel,
      net: x.net,
      ratio: totalUserNet !== 0 ? (x.net / totalUserNet) * 100 : 0,
    }))
    .sort((a, b) => b.net - a.net);

  return {
    forecastMonthEndNet,
    trailing3MonthAverageNet,
    oneYearProjectedCumulativeNet,
    currentCumulativeNet,
    monthOverMonthPercent,
    monthOverMonthBaseYm: baseYm,
    monthOverMonthTargetYm: targetYm,
    userContribution,
  };
}
