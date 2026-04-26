import { useMemo } from "react";
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { AdminSalesDailySummaryRow } from "../lib/api";
import type { AdminSalesAdvancedAnalysis } from "../lib/adminSalesAdvancedAnalysis";

/** 目標未設定 or 従来の単色 */
const BAR = "#4A90E2";
/** 目標あり・未達（日次純利益 < 目標） */
const BAR_BELOW_TARGET = "#7eb0ea";
/** 目標あり・達成以上（日次純利益 ≥ 目標） */
const BAR_MEETS_TARGET = "#2d6ab8";
const LINE = "#2563c7";

function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map((x) => Number(x));
  return new Date(y, m - 1, d, 12, 0, 0);
}

function ymdString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 指定期間の全日を 0 埋めし、累積純利益を付与
 */
type ChartRow = {
  dayKey: string;
  dayLabel: string;
  net: number;
  cumulative: number;
  salesCount: number;
  fee: number;
  gross: number;
  /** 棒の塗り（目標比で出し分け） */
  barFill: string;
  /** ツールチップ用（目標未設定は null） */
  targetY: number | null;
};

type ChartRowBase = Omit<ChartRow, "barFill" | "targetY">;

function withBarFills(rows: ChartRowBase[], targetNetY: number | null): ChartRow[] {
  const t = targetNetY != null && Number.isFinite(targetNetY) ? targetNetY : null;
  return rows.map((r) => ({
    ...r,
    targetY: t,
    barFill:
      t == null
        ? BAR
        : r.net >= t
          ? BAR_MEETS_TARGET
          : BAR_BELOW_TARGET,
  }));
}

function buildChartRows(from: string, to: string, items: AdminSalesDailySummaryRow[]): ChartRowBase[] {
  const byDay = new Map<string, AdminSalesDailySummaryRow>();
  for (const r of items) {
    const k = String((r as { day_key?: string }).day_key ?? "")
      .trim()
      .slice(0, 10);
    if (k) byDay.set(k, r);
  }
  const out: ChartRowBase[] = [];
  let d = parseYmd(from);
  const end = parseYmd(to);
  let cum = 0;
  for (; d.getTime() <= end.getTime(); d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 12, 0, 0)) {
    const key = ymdString(d);
    const r = byDay.get(key);
    const net = r != null ? Number(r.net_total ?? 0) : 0;
    const salesCount = r != null ? Number(r.sales_count ?? 0) : 0;
    const fee = r != null ? Number(r.fee_total ?? 0) : 0;
    const gross = r != null ? Number(r.gross_total ?? 0) : 0;
    cum += net;
    out.push({
      dayKey: key,
      dayLabel: d.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" }),
      net,
      cumulative: cum,
      salesCount,
      fee,
      gross,
    });
  }
  return out;
}

type TooltipProps = {
  active?: boolean;
  payload?: Array<{
    payload: {
      dayKey: string;
      dayLabel: string;
      net: number;
      cumulative: number;
      salesCount: number;
      targetY: number | null;
    };
  }>;
};

function AdminSalesTooltip({ active, payload }: TooltipProps) {
  if (!active || !payload?.[0]) return null;
  const p = payload[0].payload;
  return (
    <div
      style={{
        background: "var(--bg-card, #fff)",
        border: "1px solid var(--border, #ddd)",
        borderRadius: 8,
        padding: "0.5rem 0.65rem",
        fontSize: "0.82rem",
        boxShadow: "0 2px 8px color-mix(in srgb, var(--text, #000) 12%, transparent)",
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: "0.2rem" }}>{p.dayKey}</div>
      <div>件数：{p.salesCount.toLocaleString("ja-JP")} 件</div>
      <div>純利益：¥{Math.round(p.net).toLocaleString("ja-JP")}</div>
      {typeof p.targetY === "number" && Number.isFinite(p.targetY) ? (
        <div
          style={{
            marginTop: "0.2rem",
            color: p.net >= p.targetY ? "#0f5132" : "var(--text-muted, #666)",
          }}
        >
          目標（{Math.round(p.targetY).toLocaleString("ja-JP")}）：{p.net >= p.targetY ? "達成" : "未達"}
        </div>
      ) : null}
      <div style={{ color: "var(--text-muted, #666)" }}>
        累積純利益：¥{Math.round(p.cumulative).toLocaleString("ja-JP")}
      </div>
    </div>
  );
}

type Props = {
  from: string;
  to: string;
  items: AdminSalesDailySummaryRow[];
  loading: boolean;
  error: string | null;
  /** 日次純利益の目標（Y 左軸）。未設定は描画しない */
  targetNetY: number | null;
  advanced: AdminSalesAdvancedAnalysis | null;
};

export function AdminSalesCharts({ from, to, items, loading, error, targetNetY, advanced }: Props) {
  const data = useMemo(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
      return [];
    }
    return withBarFills(buildChartRows(from, to, items), targetNetY);
  }, [from, to, items, targetNetY]);

  const nTicks = data.length;
  const xInterval = nTicks > 45 ? Math.ceil(nTicks / 12) : nTicks > 20 ? 2 : 0;
  const chartWidthPx = Math.max(100, nTicks * 12);

  if (error) {
    return (
      <p style={{ margin: "0 0 0.6rem", color: "#b42318", fontSize: "0.9rem" }} role="alert">
        {error}
      </p>
    );
  }

  if (loading) {
    return <p style={{ margin: "0.35rem 0 0.6rem", color: "var(--text-muted)" }}>グラフを読み込み中…</p>;
  }

  if (data.length === 0) {
    return null;
  }

  return (
    <div
      style={{
        marginBottom: "1rem",
        padding: "0.6rem 0.5rem 0.2rem",
        borderRadius: 10,
        border: "1px solid var(--border)",
        background: "var(--bg-card, #fff)",
      }}
    >
      <div style={{ fontSize: "0.82rem", color: "var(--text-muted)", marginBottom: "0.4rem" }}>
        期間: {from} 〜 {to}（日付は管理画面の開始日・終了日に連動。取引のない日は 0 として表示）
        {targetNetY != null && Number.isFinite(targetNetY) ? (
          <span style={{ display: "block", marginTop: "0.25rem" }}>
            棒の色: 淡い青＝純利益が目標未満、濃い青＝目標以上
          </span>
        ) : null}
      </div>
      {advanced ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
            gap: "0.45rem",
            marginBottom: "0.45rem",
          }}
        >
          <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "0.4rem 0.5rem" }}>
            <div style={{ fontSize: "0.74rem", color: "var(--text-muted)" }}>直近3か月平均純利益</div>
            <strong>¥{Math.round(advanced.trailing3MonthAverageNet).toLocaleString("ja-JP")}</strong>
          </div>
          <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "0.4rem 0.5rem" }}>
            <div style={{ fontSize: "0.74rem", color: "var(--text-muted)" }}>今月末着地予想</div>
            <strong>¥{Math.round(advanced.forecastMonthEndNet).toLocaleString("ja-JP")}</strong>
          </div>
          <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "0.4rem 0.5rem" }}>
            <div style={{ fontSize: "0.74rem", color: "var(--text-muted)" }}>1年後の累積純利益予測</div>
            <strong>¥{Math.round(advanced.oneYearProjectedCumulativeNet).toLocaleString("ja-JP")}</strong>
          </div>
          <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "0.4rem 0.5rem" }}>
            <div style={{ fontSize: "0.74rem", color: "var(--text-muted)" }}>前月比</div>
            <strong>
              {advanced.monthOverMonthPercent == null
                ? "—"
                : `${advanced.monthOverMonthPercent >= 0 ? "+" : ""}${advanced.monthOverMonthPercent.toFixed(1)}%`}
            </strong>
          </div>
        </div>
      ) : null}
      {advanced && advanced.userContribution.length > 0 ? (
        <div style={{ marginBottom: "0.45rem", fontSize: "0.8rem", color: "var(--text-muted)" }}>
          ユーザー別利益貢献:
          {" "}
          {advanced.userContribution.slice(0, 3).map((u) => `${u.userLabel} ${u.ratio.toFixed(1)}%`).join(" / ")}
        </div>
      ) : null}
      <div
        style={{
          width: "100%",
          maxWidth: "100%",
          overflowX: "auto",
          WebkitOverflowScrolling: "touch",
        }}
        role="region"
        aria-label="純利益の推移チャート"
      >
        <div style={{ minWidth: chartWidthPx, width: "100%", height: 300, minHeight: 280 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="color-mix(in srgb, var(--text, #888) 20%, transparent)" />
            <XAxis
              dataKey="dayLabel"
              tick={{ fontSize: 10 }}
              interval={xInterval > 0 ? xInterval : "preserveStartEnd"}
            />
            <YAxis
              yAxisId="left"
              tick={{ fontSize: 11 }}
              width={56}
              tickFormatter={(v) => Number(v).toLocaleString("ja-JP")}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              tick={{ fontSize: 11 }}
              width={56}
              tickFormatter={(v) => Number(v).toLocaleString("ja-JP")}
            />
            <Tooltip content={<AdminSalesTooltip />} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {targetNetY != null && Number.isFinite(targetNetY) ? (
              <ReferenceLine
                yAxisId="left"
                y={targetNetY}
                stroke="#b42318"
                strokeDasharray="5 4"
                strokeWidth={1.5}
                label={{ value: "目標", position: "insideTopRight", fill: "#b42318", fontSize: 10 }}
              />
            ) : null}
            <Bar
              yAxisId="left"
              dataKey="net"
              name="日次純利益"
              maxBarSize={32}
              radius={[2, 2, 0, 0]}
              activeBar={{ opacity: 0.9, stroke: "rgba(15, 50, 90, 0.45)", strokeWidth: 0.5 }}
            >
              {data.map((entry) => (
                <Cell key={entry.dayKey} fill={entry.barFill} />
              ))}
            </Bar>
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="cumulative"
              name="累積純利益"
              stroke={LINE}
              dot={false}
              strokeWidth={2}
            />
          </ComposedChart>
        </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
