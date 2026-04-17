import { PiggyBank, Wallet, WalletCards } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { MetricCard } from "../components/demo/MetricCard";
import { RecentTransactions } from "../components/demo/RecentTransactions";
import { SpendingChart } from "../components/demo/SpendingChart";
import { getBalanceSummary, getMonthSummary, getTransactions } from "../lib/api";

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

export function DashboardPage() {
  const [ym, setYm] = useState(currentYm);
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
  const [totalBalance, setTotalBalance] = useState(0);
  const [balanceThroughPrevMonth, setBalanceThroughPrevMonth] = useState(0);

  const { from, to } = useMemo(() => ymToRange(ym), [ym]);
  const prevMonthEnd = useMemo(() => ymToRange(prevYm(ym)).to, [ym]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [sum, prev, tx, balanceToMonth, balanceToPrevMonthEnd] = await Promise.all([
        getMonthSummary(ym, { scope: "family" }),
        getMonthSummary(prevYm(ym), { scope: "family" }),
        getTransactions(from, to, { scope: "family" }),
        getBalanceSummary(to, { scope: "family" }),
        getBalanceSummary(prevMonthEnd, { scope: "family" }),
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
      const monthTx = (tx.items ?? []) as TxRow[];
      setTransactions(monthTx);
      setTotalBalance(num(balanceToMonth.balance));
      setBalanceThroughPrevMonth(num(balanceToPrevMonthEnd.balance));
    } catch (e) {
      setError(e instanceof Error ? e.message : "ダッシュボードの読込に失敗しました");
      setSummary(null);
      setPrevious(null);
      setTransactions([]);
      setTotalBalance(0);
      setBalanceThroughPrevMonth(0);
    } finally {
      setLoading(false);
    }
  }, [from, to, prevMonthEnd, ym]);

  useEffect(() => {
    void load();
  }, [load]);

  const balance =
    summary && summary.netMonthlyBalance != null && summary.netMonthlyBalance !== ""
      ? num(summary.netMonthlyBalance)
      : summary
        ? num(summary.incomeTotal) -
          num(summary.expenseTotal) -
          num(summary.fixedCostFromSettings)
        : 0;
  const prevBalance =
    previous && previous.netMonthlyBalance != null && previous.netMonthlyBalance !== ""
      ? num(previous.netMonthlyBalance)
      : previous
        ? num(previous.incomeTotal) -
          num(previous.expenseTotal) -
          num(previous.fixedCostFromSettings)
        : 0;
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

  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl bg-gradient-to-b from-white to-slate-50 px-4 pb-20 pt-6 text-slate-900 md:px-6">
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
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm"
            value={ym}
            onChange={(ev) => setYm(ev.target.value)}
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
          value={yen(totalBalance)}
          subLabel={loading ? "更新中…" : `${ym} までの残高合計`}
          icon={<PiggyBank size={16} />}
          trend={totalBalance >= balanceThroughPrevMonth ? "up" : "down"}
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
    </main>
  );
}
