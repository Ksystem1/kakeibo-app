import { ArrowLeft, ArrowRight, Home, Pause, Play } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { DemoBeforeChaosSection } from "../components/demo/DemoBeforeChaosSection";
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
  demoImportIdealRecent,
} from "../data/demoMockData";

const STEP_COUNT = 5;
/** ステップ0は約1秒。1以降は各3秒。合計約13秒（15秒以内）。 */
const SLIDE_MS_BEFORE = 1000;
const SLIDE_MS_AFTER = 3000;

function slideDurationMs(s: number) {
  return s === 0 ? SLIDE_MS_BEFORE : SLIDE_MS_AFTER;
}

const HIGHLIGHT =
  "ring-[3px] ring-mint-500/90 ring-offset-2 ring-offset-slate-50 shadow-[0_0_24px_rgba(16,185,129,0.2)] z-[1]";

const HIGHLIGHT_BEFORE =
  "ring-[3px] ring-rose-400/75 ring-offset-2 ring-offset-white shadow-[0_0_20px_rgba(244,63,94,0.12)] z-[1]";

/** ステップ0は共感用の少し長めの文、その後はリール用ショートコピー */
const CATCH = [
  "手入力に限界を感じていませんか？",
  "家計簿、もう書かない。",
  "何でも置くだけ。形式はアプリが自動判定。",
  "医療費は氏名×区分、ワン表で。",
  "迷わない家計簿。取り込み口は、ひとつだけ。",
] as const;

export function DemoDashboardPage() {
  const [step, setStep] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [segmentProgress, setSegmentProgress] = useState(0);

  const isBefore = step === 0;

  const [spendingData] = useState<DemoSpendingChartDatum[]>(() => [...demoBaseSpendingForChart]);
  const [recentItems] = useState(() => [...demoImportIdealRecent]);

  const copy = CATCH[step] ?? CATCH[0];
  const isLast = step === STEP_COUNT - 1;

  useEffect(() => {
    if (isPaused) {
      return;
    }

    const duration = slideDurationMs(step);
    let raf = 0;
    const t0 = performance.now();

    function frame(now: number) {
      const t = (now - t0) / duration;
      if (t >= 1) {
        setSegmentProgress(1);
        setStep((s) => (s + 1) % STEP_COUNT);
        return;
      }
      setSegmentProgress(t);
      raf = requestAnimationFrame(frame);
    }

    setSegmentProgress(0);
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [step, isPaused]);

  const stepHighlights = useMemo(() => {
    return {
      before: step === 0,
      s1receipt: step === 1,
      s1chart: step === 1,
      s1recent: step === 1,
      s2: step === 2,
      s3: step === 3,
      s4chart: step === 4,
      s4ui: step === 4,
    };
  }, [step]);

  function onManualStep(next: number) {
    setStep(next);
  }

  return (
    <main
      className={[
        "relative min-h-screen w-full max-w-6xl overflow-x-hidden px-3 pb-48 pt-9 transition-[color,background-color,background-image] duration-500 ease-out sm:px-4 md:mx-auto md:px-6",
        isBefore
          ? "bg-gradient-to-b from-rose-50/50 via-white to-slate-100 text-slate-900"
          : "bg-gradient-to-b from-emerald-50/55 via-white to-cyan-50/45 text-slate-900",
      ].join(" ")}
    >
      <div className="pointer-events-none fixed left-0 right-0 top-0 z-50 flex items-center gap-2 px-3 pt-[max(0.5rem,env(safe-area-inset-top))] text-slate-500 sm:px-4">
        <div className="pointer-events-auto flex min-w-0 flex-1 gap-1.5">
          {Array.from({ length: STEP_COUNT }, (_, i) => {
            let fill: number;
            if (i < step) {
              fill = 1;
            } else if (i > step) {
              fill = 0;
            } else {
              fill = segmentProgress;
            }
            return (
              <div
                key={i}
                className="h-0.5 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-900/12"
                aria-hidden
              >
                <div
                  className="h-full min-w-0 rounded-full bg-gradient-to-r from-amber-400 via-orange-500 to-rose-500 will-change-[width]"
                  style={{ width: `${fill * 100}%` }}
                />
              </div>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => setIsPaused((p) => !p)}
          className="pointer-events-auto flex size-7 shrink-0 items-center justify-center rounded-full opacity-60 transition hover:bg-slate-900/5 hover:opacity-100"
          title={isPaused ? "再開" : "一時停止"}
          aria-label={isPaused ? "自動再生を再開" : "自動再生を一時停止"}
        >
          {isPaused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
        </button>
        <Link
          to="/"
          className="pointer-events-auto flex size-7 shrink-0 items-center justify-center rounded-full opacity-70 transition hover:bg-slate-900/5 hover:opacity-100"
          title="トップ"
          aria-label="トップへ戻る"
        >
          <Home className="size-3.5" />
        </Link>
      </div>

      <div className="relative min-h-[48vh]">
        <div key={step} className="space-y-4 animate-demo-step-in">
          {step === 0 && <DemoBeforeChaosSection className={stepHighlights.before ? HIGHLIGHT_BEFORE : undefined} />}

          {step === 1 && (
            <>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 animate-pulse">
                <DemoReceiptImportSection
                  className={stepHighlights.s1receipt ? HIGHLIGHT : undefined}
                />
                <SpendingChart
                  className={stepHighlights.s1chart ? HIGHLIGHT : undefined}
                  data={spendingData}
                  title="日々の支出"
                  description=""
                />
              </div>
              <RecentTransactions
                className={stepHighlights.s1recent ? HIGHLIGHT : undefined}
                items={recentItems}
              />
            </>
          )}

          {step === 2 && (
            <DemoPayPayImportPreview className={stepHighlights.s2 ? HIGHLIGHT : undefined} />
          )}

          {step === 3 && (
            <DemoMedicalDeductionSection className={stepHighlights.s3 ? HIGHLIGHT : undefined} />
          )}

          {step === 4 && (
            <div className="space-y-4">
              <SpendingChart
                className={stepHighlights.s4chart ? HIGHLIGHT : undefined}
                data={spendingData}
                title="毎月の家計"
                description=""
              />
              <DemoResponsiveUiSection className={stepHighlights.s4ui ? HIGHLIGHT : undefined} />
            </div>
          )}
        </div>
      </div>

      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex flex-col items-stretch p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:items-center sm:px-4">
        <div
          className={[
            "pointer-events-auto w-full max-w-2xl rounded-2xl border px-4 py-3.5 shadow-2xl backdrop-blur-2xl sm:px-6",
            isBefore
              ? "border-rose-200/60 bg-white/90 text-slate-800 shadow-rose-900/5"
              : "border-white/30 bg-slate-950/75 text-white shadow-slate-950/40",
          ].join(" ")}
        >
          <p
            className={[
              "text-center font-bold leading-snug tracking-tight [text-shadow:0_1px_18px_rgba(0,0,0,0.06)]",
              isBefore ? "text-sm text-slate-800 sm:text-base" : "text-lg text-white [text-shadow:0_1px_18px_rgba(0,0,0,0.35)] sm:text-xl",
            ].join(" ")}
          >
            {copy}
          </p>
          {isPaused ? (
            <p
              className={[
                "mt-1.5 text-center text-[10px] font-medium tracking-wide",
                isBefore ? "text-slate-500" : "text-slate-400/90",
              ].join(" ")}
            >
              一時停止中
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 sm:mt-3">
            <button
              type="button"
              onClick={() => onManualStep(Math.max(0, step - 1))}
              disabled={step === 0}
              className={[
                "inline-flex items-center gap-1.5 rounded-full border px-3.5 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-35",
                isBefore
                  ? "border-slate-200/90 bg-slate-50/90 text-slate-700 hover:bg-slate-100/90"
                  : "border-white/15 bg-white/10 text-white/90 hover:bg-white/20",
              ].join(" ")}
            >
              <ArrowLeft className="size-4" />
              戻る
            </button>
            <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
              {!isLast ? (
                <button
                  type="button"
                  onClick={() => onManualStep(Math.min(STEP_COUNT - 1, step + 1))}
                  className="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-mint-500 to-emerald-500 px-4 py-2 text-sm font-bold text-white shadow-lg shadow-mint-900/20 hover:from-mint-400 hover:to-emerald-400"
                >
                  次へ
                  <ArrowRight className="size-4" />
                </button>
              ) : (
                <Link
                  to="/register"
                  className="inline-flex items-center justify-center gap-1.5 rounded-full bg-gradient-to-r from-amber-400 to-orange-500 px-5 py-2.5 text-sm font-bold text-slate-900 shadow-lg hover:from-amber-300 hover:to-orange-400"
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
