import { PiggyBank, Wallet, WalletCards } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { MetricCard } from "../components/demo/MetricCard";
import { RecentTransactions } from "../components/demo/RecentTransactions";
import { SpendingChart } from "../components/demo/SpendingChart";
import { getMonthSummary, getTransactions, normalizeFamilyRole } from "../lib/api";

type TxRow = {
  id: number;
  category_id: number | null;
  kind: string;
  amount: number | string;
  transaction_date: string;
  memo: string | null;
};

function currentYm() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function ymToRange(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  const from = `${y}-${String(m).padStart(2, "0")}-01`;
  const last = new Date(y, m, 0).getDate();
  const to = `${y}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
  return { from, to };
}

function prevYm(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function prevYearYm(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  return `${y - 1}-${String(m).padStart(2, "0")}`;
}

function num(v: unknown) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function yen(v: number) {
  return `¥${Math.round(v).toLocaleString("ja-JP")}`;
}

function md(raw: string | null | undefined) {
  if (!raw) return "対象月";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  return m ? `${m[2]}/${m[3]}` : raw.slice(0, 10);
}

type MonthSummaryLike = {
  incomeTotal: unknown;
  expenseTotal: unknown;
  fixedCostFromSettings?: unknown;
  netMonthlyBalance?: unknown;
};

function netMonthlyFromSummary(s: MonthSummaryLike | null): number {
  if (!s) return 0;
  if (s.netMonthlyBalance != null && s.netMonthlyBalance !== "") {
    return num(s.netMonthlyBalance);
  }
  const exp = num(s.expenseTotal);
  const inc = num(s.incomeTotal);
  const fixed = inc > 0 || exp > 0 ? num(s.fixedCostFromSettings) : 0;
  return inc - exp - fixed;
}

export function DashboardPage() {
  const { user } = useAuth();
  const [ym, setYm] = useState(() => currentYm());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<{
    incomeTotal: unknown;
    expenseTotal: unknown;
    fixedCostFromSettings?: unknown;
    netMonthlyBalance?: unknown;
    expensesByCategory: Array<{ category_name: string | null; total: unknown }>;
  } | null>(null);
  const [previous, setPrevious] = useState<{
    incomeTotal: unknown;
    expenseTotal: unknown;
    fixedCostFromSettings?: unknown;
    netMonthlyBalance?: unknown;
  } | null>(null);
  const [transactions, setTransactions] = useState<TxRow[]>([]);
  const [previousYear, setPreviousYear] = useState<{
    expensesByCategory: Array<{ category_name: string | null; total: unknown }>;
  } | null>(null);
  /** 対象月の一つ前のさらに前月（トレンド用の2ヶ月窓） */
  const [previous2, setPrevious2] = useState<MonthSummaryLike | null>(null);

  const { from, to } = useMemo(() => ymToRange(ym), [ym]);
  const prevYmStr = useMemo(() => prevYm(ym), [ym]);
  const prevYearYmStr = useMemo(() => prevYearYm(ym), [ym]);
  const prev2YmStr = useMemo(() => prevYm(prevYm(ym)), [ym]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [sum, prev, prev2, prevYear, tx] = await Promise.all([
        getMonthSummary(ym, { scope: "family" }),
        getMonthSummary(prevYmStr, { scope: "family" }),
        getMonthSummary(prev2YmStr, { scope: "family" }),
        getMonthSummary(prevYearYmStr, { scope: "family" }),
        getTransactions(from, to, { scope: "family" }),
      ]);
      setSummary({
        incomeTotal: sum.incomeTotal,
        expenseTotal: sum.expenseTotal,
        fixedCostFromSettings: sum.fixedCostFromSettings,
        netMonthlyBalance: sum.netMonthlyBalance,
        expensesByCategory: sum.expensesByCategory ?? [],
      });
      setPrevious({
        incomeTotal: prev.incomeTotal,
        expenseTotal: prev.expenseTotal,
        fixedCostFromSettings: prev.fixedCostFromSettings,
        netMonthlyBalance: prev.netMonthlyBalance,
      });
      setPrevious2({
        incomeTotal: prev2.incomeTotal,
        expenseTotal: prev2.expenseTotal,
        fixedCostFromSettings: prev2.fixedCostFromSettings,
        netMonthlyBalance: prev2.netMonthlyBalance,
      });
      setPreviousYear({
        expensesByCategory: prevYear.expensesByCategory ?? [],
      });
      const monthTx = (tx.items ?? []) as TxRow[];
      setTransactions(monthTx);
    } catch (e) {
      setError(e instanceof Error ? e.message : "ダッシュボードの読込に失敗しました");
      setSummary(null);
      setPrevious(null);
      setPrevious2(null);
      setPreviousYear(null);
      setTransactions([]);
    } finally {
      setLoading(false);
    }
  }, [from, prev2YmStr, prevYearYmStr, prevYmStr, to, ym]);

  useEffect(() => {
    void load();
  }, [load]);

  const balance = netMonthlyFromSummary(summary);
  const prevBalance = netMonthlyFromSummary(previous);
  const prev2Balance = netMonthlyFromSummary(previous2);
  /** 現在の貯金額 = 対象月の収支残高 + 前月の収支残高 */
  const savingsTwoMonth = balance + prevBalance;
  /** トレンド比較: 前月 + その前月 の合計 */
  const savingsPriorWindow = prevBalance + prev2Balance;
  const balanceDiffPct =
    prevBalance === 0 ? 0 : ((balance - prevBalance) / Math.abs(prevBalance)) * 100;
  const chartColors = ["#2fbf71", "#86efac", "#fdba74", "#fb923c", "#cbd5e1"];
  const chartData = (summary?.expensesByCategory ?? []).slice(0, 5).map((r, i) => ({
    name: r.category_name ?? "未分類",
    value: Math.max(0, Math.round(num(r.total))),
    color: chartColors[i % chartColors.length],
  }));
  const recentItems = transactions
    .filter((t) => t.kind === "expense")
    .slice(0, 3)
    .map((t) => ({
      id: t.id,
      category: t.memo?.includes("電気") ? "光熱費" : "食費",
      title: t.memo?.trim() ? t.memo : "支出",
      amount: Math.round(num(t.amount)),
      time: md(t.transaction_date),
    }));

  const categoryYoYRows = useMemo(() => {
    const thisMap = new Map<string, number>();
    const prevMap = new Map<string, number>();
    for (const r of summary?.expensesByCategory ?? []) {
      const name = String(r?.category_name ?? "未分類").trim() || "未分類";
      thisMap.set(name, Math.round(num(r?.total)));
    }
    for (const r of previousYear?.expensesByCategory ?? []) {
      const name = String(r?.category_name ?? "未分類").trim() || "未分類";
      prevMap.set(name, Math.round(num(r?.total)));
    }
    const names = [...new Set([...thisMap.keys(), ...prevMap.keys()])];
    return names
      .map((name) => {
        const current = thisMap.get(name) ?? 0;
        const previousValue = prevMap.get(name) ?? 0;
        const diff = current - previousValue;
        const pct = previousValue === 0 ? null : (diff / Math.abs(previousValue)) * 100;
        return { name, current, previous: previousValue, diff, pct };
      })
      .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
      .slice(0, 10);
  }, [summary?.expensesByCategory, previousYear?.expensesByCategory]);

  const aiInsights = useMemo(() => {
    if (categoryYoYRows.length === 0) return [];
    const top = categoryYoYRows[0];
    const down = categoryYoYRows.find((r) => r.diff < 0) ?? null;
    const energy =
      categoryYoYRows.find((r) => /電気|光熱|水道|ガス/.test(r.name)) ?? null;
    const out: string[] = [];
    if (energy) {
      out.push(
        `${energy.name} は前年同月比で ${energy.diff >= 0 ? "+" : ""}${yen(energy.diff)} の差です。`,
      );
    }
    out.push(
      `最も差が大きいのは「${top.name}」で、前年同月比 ${top.diff >= 0 ? "+" : ""}${yen(top.diff)} です。`,
    );
    if (down) {
      out.push(`減少カテゴリでは「${down.name}」が ${yen(down.diff)} と改善しています。`);
    }
    return out;
  }, [categoryYoYRows]);

  /** 子ども（KID）は家族ダッシュボードではなくお小遣い帳（ルート `/`）へ（hooks の後で判定） */
  if (normalizeFamilyRole(user?.familyRole) === "KID") {
    return <Navigate to="/" replace />;
  }

  return (
    <>
    <main className="mx-auto min-h-screen w-full max-w-6xl bg-gradient-to-b from-slate-200/90 to-slate-100 px-4 pb-20 pt-6 text-slate-900 md:px-6">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold tracking-wide text-mint-600">Family Dashboard</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">家族ダッシュボード</h1>
          <p className="mt-1 text-sm text-slate-500">対象月の実データを表示しています</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs font-semibold text-slate-500" htmlFor="dashboard-month">
            対象月
          </label>
          <input
            id="dashboard-month"
            type="month"
            required
            className="rounded-lg border border-slate-300/90 bg-white px-2.5 py-1.5 text-sm shadow-sm"
            value={ym}
            onChange={(ev) => {
              if (ev.target.value) setYm(ev.target.value);
            }}
          />
        </div>
      </header>

      {error ? <p className="mb-4 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}

      <section className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <MetricCard
          label="今月の残り予算"
          value={summary ? yen(balance) : loading ? "更新中…" : "—"}
          subLabel={loading ? "更新中…" : `${ym} の実績（収入−変動費−設定の固定費）`}
          icon={<Wallet size={16} />}
          trend={balance >= 0 ? "up" : "down"}
        />
        <MetricCard
          label="現在の貯金額"
          value={summary ? yen(savingsTwoMonth) : loading ? "更新中…" : "—"}
          subLabel={
            loading
              ? "更新中…"
              : `${ym} の残高 + ${prevYmStr} の残高（各月とも収入−変動費−設定固定費）`
          }
          icon={<PiggyBank size={16} />}
          trend={savingsTwoMonth >= savingsPriorWindow ? "up" : "down"}
        />
        <MetricCard
          label="前月比"
          value={`${balanceDiffPct >= 0 ? "+" : ""}${balanceDiffPct.toFixed(1)}%`}
          subLabel={loading ? "更新中…" : `${prevYm(ym)} 比較`}
          icon={<WalletCards size={16} />}
          trend={balanceDiffPct >= 0 ? "up" : "down"}
        />
      </section>

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <SpendingChart data={chartData} />
        <RecentTransactions items={recentItems} />
      </div>
      <section className="mt-5 rounded-xl border border-slate-300/70 bg-white/80 p-3 shadow-sm">
        <h2 className="text-base font-semibold">カテゴリ別 前年同月差異（{ym} vs {prevYearYmStr}）</h2>
        {categoryYoYRows.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">比較データがありません。</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-slate-600">
                  <th className="px-2 py-1 text-left">カテゴリ</th>
                  <th className="px-2 py-1 text-right">{ym}</th>
                  <th className="px-2 py-1 text-right">{prevYearYmStr}</th>
                  <th className="px-2 py-1 text-right">差異</th>
                  <th className="px-2 py-1 text-right">比率</th>
                </tr>
              </thead>
              <tbody>
                {categoryYoYRows.map((r) => (
                  <tr key={r.name} className="border-t border-slate-200/80">
                    <td className="px-2 py-1">{r.name}</td>
                    <td className="px-2 py-1 text-right">{yen(r.current)}</td>
                    <td className="px-2 py-1 text-right">{yen(r.previous)}</td>
                    <td className={`px-2 py-1 text-right ${r.diff > 0 ? "text-rose-600" : r.diff < 0 ? "text-emerald-700" : "text-slate-500"}`}>
                      {r.diff >= 0 ? "+" : ""}
                      {yen(r.diff)}
                    </td>
                    <td className="px-2 py-1 text-right">
                      {r.pct == null ? "—" : `${r.pct >= 0 ? "+" : ""}${r.pct.toFixed(1)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-3 rounded-lg bg-slate-50 p-2.5">
          <p className="text-xs font-semibold tracking-wide text-slate-600">AI分析（自動）</p>
          {aiInsights.length > 0 ? (
            <ul className="mt-1 list-disc pl-5 text-sm text-slate-700">
              {aiInsights.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-sm text-slate-500">分析対象データが不足しています。</p>
          )}
        </div>
      </section>
    </main>
    </>
  );
}
