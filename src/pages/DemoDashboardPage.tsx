import { ArrowLeft, ArrowRight, Link2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { DemoPayPayImportPreview } from "../components/demo/DemoPayPayImportPreview";
import {
  DemoMedicalDeductionSection,
  DemoReceiptImportSection,
  DemoResponsiveUiSection,
} from "../components/demo/DemoFeatureSections";
import { RecentTransactions } from "../components/demo/RecentTransactions";
import { SpendingChart } from "../components/demo/SpendingChart";
import {
  type DemoSpendingChartDatum,
  demoBaseSpendingForChart,
  demoRecentForHero,
} from "../data/demoMockData";

const STEP_COUNT = 4;

const HIGHLIGHT =
  "ring-[3px] ring-mint-500/90 ring-offset-2 ring-offset-slate-50 shadow-[0_0_24px_rgba(16,185,129,0.2)] z-[1]";

const STORY = [
  {
    title: "ステップ1 / 4　無料機能",
    body:
      "スマホで撮るだけ。レシートをAIが解析し、家計簿を自動作成。日々の支出をグラフで可視化して、無駄遣いを一目で発見できます。",
  },
  {
    title: "ステップ2 / 4　プレミアム新機能",
    body:
      "【新機能】PayPayの利用履歴を一括取込。コンビニやランチなどの細かい支払いも、入力の手間なく一瞬で家計簿に反映されます。",
  },
  {
    title: "ステップ3 / 4　プレミアム機能",
    body:
      "家族全員の医療費を自動集計。国税庁フォーマットのCSV出力に対応し、面倒な確定申告の準備が数秒で完了します。",
  },
  {
    title: "ステップ4 / 4　進化したUI",
    body: "PCでもスマホでも。こだわりのUIで、どこにいてもサクサク管理。固定費の自動反映も、もう迷わせません。",
  },
] as const;

function cn(...a: (string | false | undefined)[]) {
  return a.filter(Boolean).join(" ");
}

export function DemoDashboardPage() {
  const [step, setStep] = useState(0);

  const [spendingData] = useState<DemoSpendingChartDatum[]>(() => [...demoBaseSpendingForChart]);
  const [recentItems] = useState(() => [...demoRecentForHero]);

  const story = STORY[step] ?? STORY[0];
  const isLast = step === STEP_COUNT - 1;

  const stepHighlights = useMemo(() => {
    return {
      s0receipt: step === 0,
      s0chart: step === 0,
      s0recent: step === 0,
      s1: step === 1,
      s2: step === 2,
      s3chart: step === 3,
      s3ui: step === 3,
    };
  }, [step]);

  return (
    <main className="relative min-h-screen w-full max-w-6xl bg-gradient-to-b from-white to-slate-50 px-4 pb-52 pt-6 text-slate-900 md:mx-auto md:px-6">
      <header className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold tracking-wide text-mint-600">Kakeibo 体験デモ</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">全{STEP_COUNT}ステップ紙芝居</h1>
          <p className="mt-1 text-sm text-slate-500">
            フロントのモックデータのみ。DB には接続しません。下のカードで進めてください。
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Link
              to="/"
              className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
            >
              <Link2 className="size-3" />
              トップへ戻る
            </Link>
            {Array.from({ length: STEP_COUNT }, (_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setStep(i)}
                className={cn(
                  "h-2 w-2 rounded-full transition",
                  i === step ? "bg-mint-600 w-5" : "bg-slate-300 hover:bg-slate-400",
                )}
                aria-label={`ステップ${i + 1}へ`}
              />
            ))}
          </div>
        </div>
      </header>

      <div className="min-h-[42vh]">
        {step === 0 && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <DemoReceiptImportSection
                className={stepHighlights.s0receipt ? HIGHLIGHT : undefined}
              />
              <SpendingChart
                className={stepHighlights.s0chart ? HIGHLIGHT : undefined}
                data={spendingData}
                title="日々の支出（グラフで可視化）"
                description="レシート連携のイメージ。円で比率を把握（サンプル数値）"
              />
            </div>
            <RecentTransactions
              className={stepHighlights.s0recent ? HIGHLIGHT : undefined}
              items={recentItems}
            />
          </div>
        )}

        {step === 1 && (
          <DemoPayPayImportPreview className={stepHighlights.s1 ? HIGHLIGHT : undefined} />
        )}

        {step === 2 && (
          <DemoMedicalDeductionSection className={stepHighlights.s2 ? HIGHLIGHT : undefined} />
        )}

        {step === 3 && (
          <div className="space-y-4">
            <SpendingChart
              className={stepHighlights.s3chart ? HIGHLIGHT : undefined}
              data={spendingData}
              title="品目別・支出（固定費の自動反映）"
              description="毎月の固定費も一緒に表示。大画面で俯瞰、スマホは下のカード"
            />
            <DemoResponsiveUiSection className={stepHighlights.s3ui ? HIGHLIGHT : undefined} />
          </div>
        )}
      </div>

      {/* 説明カード（下部固定・透過） */}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center p-3 md:p-4">
        <div className="pointer-events-auto w-full max-w-2xl rounded-2xl border border-white/20 bg-slate-900/80 px-4 py-3.5 shadow-2xl shadow-black/30 backdrop-blur-md md:px-5">
          <p className="text-[11px] font-bold tracking-wide text-mint-300/95">{story.title}</p>
          <p className="mt-1.5 text-sm leading-relaxed text-slate-100">{story.body}</p>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setStep((s) => Math.max(0, s - 1))}
              disabled={step === 0}
              className="inline-flex items-center gap-1.5 rounded-xl border border-white/20 bg-white/10 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ArrowLeft className="size-4" />
              戻る
            </button>
            <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
              {!isLast ? (
                <button
                  type="button"
                  onClick={() => setStep((s) => Math.min(STEP_COUNT - 1, s + 1))}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-mint-500 px-4 py-2 text-sm font-bold text-white shadow-lg shadow-mint-500/30 hover:bg-mint-600"
                >
                  次へ
                  <ArrowRight className="size-4" />
                </button>
              ) : (
                <Link
                  to="/register"
                  className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-amber-400 to-orange-500 px-5 py-2.5 text-sm font-bold text-slate-900 shadow-lg hover:from-amber-300 hover:to-orange-400"
                >
                  今すぐ無料で始める
                </Link>
              )}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
