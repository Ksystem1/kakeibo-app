import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";

type SpendingDatum = {
  name: string;
  value: number;
  color: string;
};

type SpendingChartProps = {
  data: SpendingDatum[];
};

export function SpendingChart({ data }: SpendingChartProps) {
  return (
    <section className="rounded-2xl border border-slate-200/95 bg-white p-4 shadow-md ring-1 ring-slate-900/[0.04]">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-slate-900">今月のカテゴリ別支出</h2>
        <p className="mt-1 text-xs text-slate-500">食費や光熱費の比率が一目でわかります</p>
      </div>

      <div className="h-52 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              innerRadius={52}
              outerRadius={78}
              dataKey="value"
              strokeWidth={0}
              paddingAngle={2}
            >
              {data.map((entry) => (
                <Cell key={entry.name} fill={entry.color} />
              ))}
            </Pie>
            <Tooltip
              formatter={(v) => `¥${Number(v ?? 0).toLocaleString("ja-JP")}`}
              contentStyle={{
                borderRadius: 12,
                border: "1px solid #e2e8f0",
                boxShadow: "0 8px 20px rgba(15, 23, 42, 0.08)",
              }}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>

      <ul className="mt-3 grid grid-cols-2 gap-2 text-xs">
        {data.map((item) => (
          <li key={item.name} className="flex items-center justify-between rounded-lg bg-slate-50 px-2 py-1.5">
            <span className="flex items-center gap-1.5 text-slate-600">
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: item.color }}
                aria-hidden
              />
              {item.name}
            </span>
            <span className="font-semibold text-slate-900">¥{item.value.toLocaleString("ja-JP")}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
