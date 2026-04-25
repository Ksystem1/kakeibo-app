import { Pause, PiggyBank, Play, Plus, Wallet, WalletCards } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  DemoMedicalDeductionSection,
  DemoReceiptImportSection,
  DemoResponsiveUiSection,
} from "../components/demo/DemoFeatureSections";
import { MetricCard } from "../components/demo/MetricCard";
import { RecentTransactions } from "../components/demo/RecentTransactions";
import { SpendingChart } from "../components/demo/SpendingChart";
import {
  type DemoRecentTransaction,
  type DemoSpendingChartDatum,
  demoBaseSpendingForChart,
  demoRecentForHero,
  demoTypingInputs,
} from "../data/demoMockData";

type SpeedPreset = "slow" | "normal" | "fast";

const speedMap: Record<
  SpeedPreset,
  {
    loopStartDelay: number;
    categoryTypeMs: number;
    amountTypeMs: number;
    betweenFieldsMs: number;
    submitDelayMs: number;
    afterUpdateDelayMs: number;
    numberAnimMs: number;
  }
> = {
  slow: {
    loopStartDelay: 2800,
    categoryTypeMs: 135,
    amountTypeMs: 110,
    betweenFieldsMs: 500,
    submitDelayMs: 600,
    afterUpdateDelayMs: 2200,
    numberAnimMs: 900,
  },
  normal: {
    loopStartDelay: 2200,
    categoryTypeMs: 100,
    amountTypeMs: 80,
    betweenFieldsMs: 350,
    submitDelayMs: 450,
    afterUpdateDelayMs: 1800,
    numberAnimMs: 700,
  },
  fast: {
    loopStartDelay: 1500,
    categoryTypeMs: 70,
    amountTypeMs: 55,
    betweenFieldsMs: 220,
    submitDelayMs: 280,
    afterUpdateDelayMs: 1000,
    numberAnimMs: 420,
  },
};

function yen(n: number) {
  return `¥${Math.round(n).toLocaleString("ja-JP")}`;
}

function pct(n: number) {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

export function DemoDashboardPage() {
  const [isRunning, setIsRunning] = useState(true);
  const [speed, setSpeed] = useState<SpeedPreset>("normal");
  const [showModal, setShowModal] = useState(false);
  const [typedCategory, setTypedCategory] = useState("");
  const [typedAmount, setTypedAmount] = useState("");
  const [remainingBudget, setRemainingBudget] = useState(42800);
  const [savings, setSavings] = useState(1284000);
  const [monthDelta, setMonthDelta] = useState(-12.4);
  const [spendingData, setSpendingData] = useState<DemoSpendingChartDatum[]>(() => [
    ...demoBaseSpendingForChart,
  ]);
  const [recentItems, setRecentItems] = useState<DemoRecentTransaction[]>(() => [...demoRecentForHero]);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const loopIndexRef = useRef(0);
  const runningRef = useRef(true);
  const speedRef = useRef<SpeedPreset>("normal");
  const remainingRef = useRef(42800);
  const savingsRef = useRef(1284000);
  const deltaRef = useRef(-12.4);

  function clearTimers() {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (rafRef.current != null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }

  function animateNumber(setter: (n: number) => void, from: number, to: number, durationMs: number) {
    if (!runningRef.current) return;
    const start = performance.now();
    const delta = to - from;
    const step = (now: number) => {
      if (!runningRef.current) return;
      const p = Math.min(1, (now - start) / durationMs);
      const eased = 1 - (1 - p) ** 3;
      setter(from + delta * eased);
      if (p < 1) {
        rafRef.current = window.requestAnimationFrame(step);
      }
    };
    rafRef.current = window.requestAnimationFrame(step);
  }

  function typeText(text: string, setter: (v: string) => void, done: () => void, speedMs = 90) {
    let i = 0;
    setter("");
    const tick = () => {
      if (!runningRef.current) return;
      i += 1;
      setter(text.slice(0, i));
      if (i < text.length) {
        timerRef.current = window.setTimeout(tick, speedMs);
      } else {
        done();
      }
    };
    timerRef.current = window.setTimeout(tick, speedMs);
  }

  useEffect(() => {
    remainingRef.current = remainingBudget;
  }, [remainingBudget]);
  useEffect(() => {
    savingsRef.current = savings;
  }, [savings]);
  useEffect(() => {
    deltaRef.current = monthDelta;
  }, [monthDelta]);
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

  useEffect(() => {
    runningRef.current = isRunning;
    if (!isRunning) {
      clearTimers();
      return;
    }

    const runLoop = () => {
      if (!runningRef.current) return;
      const demo = demoTypingInputs[loopIndexRef.current % demoTypingInputs.length];
      loopIndexRef.current += 1;
      const conf = speedMap[speedRef.current];

      timerRef.current = window.setTimeout(() => {
        if (!runningRef.current) return;
        setShowModal(true);
        setTypedCategory("");
        setTypedAmount("");

        typeText(demo.category, setTypedCategory, () => {
          timerRef.current = window.setTimeout(() => {
            typeText(`${demo.amount.toLocaleString("ja-JP")}円`, setTypedAmount, () => {
              timerRef.current = window.setTimeout(() => {
                if (!runningRef.current) return;
                setShowModal(false);
                setTypedCategory("");
                setTypedAmount("");

                setSpendingData((prev: DemoSpendingChartDatum[]) =>
                  prev.map((d: DemoSpendingChartDatum) =>
                    d.name === demo.category ? { ...d, value: d.value + demo.amount } : d,
                  ),
                );
                setRecentItems((prev: DemoRecentTransaction[]) => [
                  {
                    id: Date.now(),
                    category: demo.category,
                    title: demo.title,
                    amount: demo.amount,
                    time: "たった今",
                  },
                  ...prev.slice(0, 2),
                ]);

                animateNumber(
                  setRemainingBudget,
                  remainingRef.current,
                  remainingRef.current - demo.amount,
                  conf.numberAnimMs,
                );
                animateNumber(
                  setSavings,
                  savingsRef.current,
                  savingsRef.current + Math.round(demo.amount * 0.25),
                  conf.numberAnimMs,
                );
                animateNumber(
                  setMonthDelta,
                  deltaRef.current,
                  deltaRef.current - 0.2,
                  conf.numberAnimMs,
                );

                timerRef.current = window.setTimeout(runLoop, conf.afterUpdateDelayMs);
              }, conf.submitDelayMs);
            }, conf.amountTypeMs);
          }, conf.betweenFieldsMs);
        }, conf.categoryTypeMs);
      }, conf.loopStartDelay);
    };

    runLoop();
    return () => {
      clearTimers();
    };
  }, [isRunning, speed]);

  const fabClass = useMemo(
    () =>
      `fixed bottom-6 left-1/2 z-10 flex h-14 w-14 -translate-x-1/2 items-center justify-center rounded-full bg-mint-500 text-white shadow-lg shadow-mint-500/30 transition focus:outline-none focus:ring-4 focus:ring-mint-200 ${
        isRunning ? "animate-pulse hover:bg-mint-600" : "hover:bg-mint-600"
      }`,
    [isRunning],
  );

  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl bg-gradient-to-b from-white to-slate-50 px-4 pb-28 pt-6 text-slate-900 md:px-6">
      <header className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold tracking-wide text-mint-600">Kakeibo Demo</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">今月の家計（体験デモ）</h1>
          <p className="mt-1 text-sm text-slate-500">
            下記はすべてフロントのサンプルです。ログイン不要・<strong>DB には接続しません</strong>。
          </p>
          <Link
            to="/"
            className="mt-2 inline-flex rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
          >
            トップへ戻る
          </Link>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <button
            type="button"
            onClick={() => setIsRunning((v) => !v)}
            className="flex items-center gap-1 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm"
          >
            {isRunning ? <Pause size={14} /> : <Play size={14} />}
            {isRunning ? "一時停止" : "再開"}
          </button>
          <div className="flex items-center gap-1 rounded-full border border-slate-200 bg-white p-1 text-[11px] font-semibold text-slate-600 shadow-sm">
            <button
              type="button"
              onClick={() => setSpeed("slow")}
              className={`rounded-full px-2 py-1 transition ${
                speed === "slow" ? "bg-slate-900 text-white" : "hover:bg-slate-100"
              }`}
            >
              ゆっくり
            </button>
            <button
              type="button"
              onClick={() => setSpeed("normal")}
              className={`rounded-full px-2 py-1 transition ${
                speed === "normal" ? "bg-slate-900 text-white" : "hover:bg-slate-100"
              }`}
            >
              標準
            </button>
            <button
              type="button"
              onClick={() => setSpeed("fast")}
              className={`rounded-full px-2 py-1 transition ${
                speed === "fast" ? "bg-slate-900 text-white" : "hover:bg-slate-100"
              }`}
            >
              高速
            </button>
          </div>
        </div>
      </header>

      <section className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <MetricCard
          label="今月の残り予算"
          value={yen(remainingBudget)}
          subLabel="登録ごとに自動更新（デモ数値）"
          icon={<Wallet size={16} />}
          trend="down"
        />
        <MetricCard
          label="現在の貯金額"
          value={yen(savings)}
          subLabel="目標まで 64%（イメージ）"
          icon={<PiggyBank size={16} />}
          trend="up"
        />
        <MetricCard
          label="前月比"
          value={pct(monthDelta)}
          subLabel="支出の傾向（デモ）"
          icon={<WalletCards size={16} />}
          trend="up"
        />
      </section>

      <p className="mb-3 mt-5 text-xs leading-relaxed text-slate-600">
        医療費控除の集計、最新のモバイル／PC 向け UI、固定費を含む支出の見える化、レシート取込の流れを
        <strong>この1ページ</strong>で掴めます（すべて静的データ）。
      </p>

      <div className="mb-5">
        <DemoMedicalDeductionSection />
      </div>

      <div className="mb-5">
        <DemoResponsiveUiSection />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <SpendingChart
          data={spendingData}
          title="品目別・支出（固定費を含む）"
          description="固定費は毎月の集計に自動で含まれる想定。カラフルな円で支出の内訳を把握できます。"
        />
        <RecentTransactions items={recentItems} />
      </div>

      <div className="mt-5">
        <DemoReceiptImportSection />
      </div>

      <button
        type="button"
        className={`${fabClass} md:left-auto md:right-8 md:translate-x-0`}
        aria-label="支出を追加"
      >
        <Plus size={24} />
      </button>

      {showModal ? (
        <div className="fixed inset-0 z-20 flex items-end justify-center bg-slate-900/35 p-3">
          <section className="w-full max-w-[360px] rounded-2xl bg-white p-4 shadow-2xl">
            <h2 className="text-sm font-semibold text-slate-900">支出入力</h2>
            <div className="mt-3 space-y-2">
              <label className="block text-xs text-slate-500">
                カテゴリ
                <div className="mt-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-900">
                  {typedCategory || " "}
                </div>
              </label>
              <label className="block text-xs text-slate-500">
                金額
                <div className="mt-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-900">
                  {typedAmount || " "}
                </div>
              </label>
            </div>
            <button
              type="button"
              className="mt-4 w-full rounded-xl bg-mint-500 px-3 py-2.5 text-sm font-semibold text-white"
            >
              登録
            </button>
          </section>
        </div>
      ) : null}
    </main>
  );
}
