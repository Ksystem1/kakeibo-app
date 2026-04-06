import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";

type Trend = "up" | "down" | "neutral";

type MetricCardProps = {
  label: string;
  value: string;
  subLabel: string;
  icon: ReactNode;
  trend?: Trend;
};

export function MetricCard({
  label,
  value,
  subLabel,
  icon,
  trend = "neutral",
}: MetricCardProps) {
  const trendColor =
    trend === "up"
      ? "text-mint-600"
      : trend === "down"
        ? "text-rose-500"
        : "text-slate-500";

  return (
    <article className="rounded-2xl border border-slate-100 bg-white p-4 shadow-soft">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs font-medium tracking-wide text-slate-500">{label}</p>
        <span className="rounded-full bg-slate-50 p-2 text-slate-500">{icon}</span>
      </div>
      <p className="text-2xl font-bold tracking-tight text-slate-900">{value}</p>
      <p className={`mt-1 flex items-center gap-1 text-xs font-medium ${trendColor}`}>
        {trend === "up" ? <ArrowUpRight size={14} /> : null}
        {trend === "down" ? <ArrowDownRight size={14} /> : null}
        <span>{subLabel}</span>
      </p>
    </article>
  );
}
