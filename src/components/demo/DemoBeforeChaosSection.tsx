import { FileWarning, Receipt, Sparkles } from "lucide-react";
import type { DemoSectionClassProps } from "./DemoFeatureSections";

const SCRIBBLES = [
  { t: "298？？", x: "8%", y: "12%", r: -8 },
  { t: "未入力", x: "68%", y: "8%", r: 6 },
  { t: "いくら？", x: "75%", y: "38%", r: 14 },
  { t: "…", x: "18%", y: "58%", r: 3 },
  { t: "医療費？", x: "42%", y: "22%", r: -5 },
  { t: "Pay", x: "12%", y: "78%", r: 10 },
] as const;

const RECEIPT_STYLES = [
  { x: "72%", y: "12%", r: 12, s: 1 },
  { x: "82%", y: "28%", r: -8, s: 0.85 },
  { x: "88%", y: "48%", r: 18, s: 0.9 },
  { x: "78%", y: "64%", r: -4, s: 0.95 },
  { x: "14%", y: "26%", r: -14, s: 0.75 },
] as const;

/**
 * ステップ0（Before）— 明るいトーンで「情報の煩雑さ・手入力の限界」を表現。DB 非接触。
 */
export function DemoBeforeChaosSection({ className }: DemoSectionClassProps) {
  return (
    <section
      className={[
        "relative isolate min-h-[min(58vh,420px)] overflow-hidden rounded-2xl",
        "border border-slate-200/95 bg-gradient-to-b from-white via-slate-50/95 to-slate-100/90 p-4 shadow-md md:min-h-[min(50vh,480px)] md:p-6",
        "ring-1 ring-slate-200/60",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* うっすら見える「きれいな家計UI」のゴースト（本番UIの雰囲気のみ） */}
      <div
        className="pointer-events-none absolute inset-2 grid grid-cols-2 gap-2 opacity-[0.22] sm:inset-3"
        aria-hidden
      >
        <div className="rounded-xl border border-slate-200/60 bg-white/60 p-2">
          <div className="mx-auto size-20 rounded-full border-8 border-slate-200/80 border-t-mint-500/30" />
          <div className="mt-2 h-1.5 w-3/4 rounded bg-slate-200/80" />
        </div>
        <div className="space-y-1.5 rounded-xl border border-slate-200/60 bg-white/60 p-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex justify-between gap-1">
              <div className="h-1.5 flex-1 rounded bg-slate-200/70" />
              <div className="h-1.5 w-10 rounded bg-slate-200/50" />
            </div>
          ))}
        </div>
        <div className="col-span-2 space-y-1.5 rounded-xl border border-slate-200/60 bg-white/50 p-2">
          <div className="h-2 w-1/3 rounded bg-slate-200/60" />
          <div className="h-1.5 w-full rounded bg-slate-200/50" />
          <div className="h-1.5 w-4/5 rounded bg-slate-200/50" />
        </div>
      </div>

      <div
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-rose-50/25 via-transparent to-amber-50/20"
        aria-hidden
      />

      {/* 散らばった「文字の乱れ」 */}
      {SCRIBBLES.map((s) => (
        <span
          key={s.t}
          className="pointer-events-none absolute font-mono text-[10px] font-bold text-slate-500/70 sm:text-xs"
          style={{ left: s.x, top: s.y, transform: `rotate(${s.r}deg)` }}
        >
          {s.t}
        </span>
      ))}

      {/* レシート風アイコン（重なり＝煩雑さ） */}
      {RECEIPT_STYLES.map((r, i) => (
        <div
          key={i}
          className="pointer-events-none absolute text-slate-400/90"
          style={{
            left: r.x,
            top: r.y,
            transform: `translate(-50%, -50%) rotate(${r.r}deg) scale(${r.s})`,
          }}
          aria-hidden
        >
          <Receipt className="size-9 drop-shadow sm:size-10" strokeWidth={1.25} />
        </div>
      ))}

      {/* 手書きメモ風（明るい紙） */}
      <div className="absolute left-3 top-1/2 w-[min(44%,180px)] -translate-y-1/2 -rotate-3 sm:left-5 sm:w-[200px]">
        <div className="rounded-lg border border-amber-200/80 bg-[#fcfaf6] p-2.5 shadow-sm ring-1 ring-amber-100/80">
          <p className="font-mono text-[9px] text-slate-500 line-through decoration-rose-300/80">1/5 雑費</p>
          <ul className="mt-1.5 space-y-0.5">
            {[0, 1, 2, 3, 4, 5, 6].map((i) => (
              <li
                key={i}
                className="h-px w-full origin-left bg-slate-300/50"
                style={{ transform: `translateX(${(i % 3) * 3 - 1}px) rotate(${(i % 5) * 0.5}deg) scaleX(${0.8 + (i % 2) * 0.1})` }}
              />
            ))}
          </ul>
          <p className="mt-1.5 font-mono text-[8px] text-rose-500/80">?円 合わない…</p>
        </div>
      </div>

      {/* 吹き出し・感情 */}
      <div
        className="absolute right-[8%] top-[18%] z-[2] max-w-[140px] rounded-2xl border border-rose-200/90 bg-white/95 px-2.5 py-1.5 text-center text-[11px] font-bold text-slate-800 shadow-md sm:max-w-[180px] sm:px-3 sm:py-2 sm:text-xs"
        style={{ boxShadow: "0 6px 16px rgba(0,0,0,0.08)" }}
      >
        もう限界…
        <span className="ml-0.5" aria-hidden>
          😫
        </span>
        <div className="absolute -left-1.5 bottom-2 h-0 w-0 border-y-6 border-r-8 border-y-transparent border-r-white" />
      </div>

      <div className="absolute left-[28%] top-[8%] z-[2] flex items-center gap-0.5 rounded-full border border-slate-200/90 bg-white/90 px-2 py-0.5 text-sm font-bold text-amber-600 shadow-sm sm:text-base">
        <span aria-hidden>⁉️</span>
        <span className="text-[10px] font-bold text-slate-600 sm:text-xs">合計 いくつ？</span>
      </div>

      <div className="absolute bottom-[22%] right-[6%] z-[2] flex size-9 items-center justify-center rounded-full border border-amber-200/80 bg-amber-50/95 text-base shadow sm:size-10">
        <FileWarning className="size-4 text-amber-600/90" />
      </div>

      <div className="relative z-[1] flex flex-col items-center justify-center gap-1 pt-6 text-center sm:pt-8">
        <p className="flex items-center justify-center gap-1 text-2xl font-bold tracking-tight text-slate-800 sm:text-3xl">
          <span aria-hidden>？</span>
          <span className="text-rose-500" aria-hidden>
            !
          </span>
          <span aria-hidden>？</span>
        </p>
        <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-slate-400">Before</p>
        <p className="mt-0.5 max-w-xs px-2 text-xs leading-relaxed text-slate-500">
          入力、メモ、支払い、レシート…{' '}
          <Sparkles className="inline size-3.5 -translate-y-0.5 text-amber-400" aria-hidden />
        </p>
      </div>

      <p className="sr-only">手書き帳面と散らばるレシートの煩雑さのイメージ。</p>
    </section>
  );
}
