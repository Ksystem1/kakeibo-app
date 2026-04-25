import type { DemoSectionClassProps } from "./DemoFeatureSections";

/**
 * ステップ0（Before）— 家計の「手入力の限界」を想起させるビジュアル。DB 非接触。
 */
export function DemoBeforeChaosSection({ className }: DemoSectionClassProps) {
  return (
    <section
      className={[
        "relative isolate min-h-[min(58vh,420px)] overflow-hidden rounded-2xl",
        "border border-slate-700/90 bg-slate-950 p-4 shadow-2xl shadow-black/50 md:min-h-[min(50vh,480px)] md:p-6",
        "ring-1 ring-amber-950/20",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_0%,rgba(30,27,20,0.4),transparent_55%)]"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_80%_100%,rgba(20,20,30,0.5),transparent_50%)]"
        aria-hidden
      />

      {/* 手書き風のぐちゃぐちゃ帳面 */}
      <div className="absolute left-4 top-1/2 w-[min(45%,200px)] -translate-y-1/2 -rotate-6 sm:left-6">
        <div
          className="rounded border border-amber-900/60 bg-[#2a2520] p-3 shadow-lg"
          style={{ boxShadow: "4px 6px 0 rgba(0,0,0,0.4)" }}
        >
          <p className="font-mono text-[9px] text-amber-200/30 line-through decoration-red-500/60">
            1/5 雑費
          </p>
          <ul className="mt-1.5 space-y-1">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <li
                key={i}
                className="h-0.5 w-full origin-left bg-amber-200/20"
                style={{ transform: `translateX(${(i % 3) * 4 - 2}px) rotate(${(i % 5) * 0.8}deg) scaleX(${0.85 + (i % 3) * 0.05})` }}
              />
            ))}
          </ul>
          <p className="mt-2 text-[8px] text-red-300/50">?円 いくつ？</p>
        </div>
        <p className="mt-1 text-center text-[8px] text-slate-500">修正だらけの手書き帳面</p>
      </div>

      {/* レシートの山＋小さなシルエット感 */}
      <div className="absolute bottom-0 right-0 w-[min(60%,320px)] translate-y-1">
        <div className="relative h-44 sm:h-52">
          {[
            { r: 8, o: 0, y: 0, w: 85 },
            { r: -6, o: 0.1, y: 8, w: 80 },
            { r: 14, o: 0.2, y: 16, w: 90 },
            { r: -4, o: 0.3, y: 28, w: 78 },
            { r: 10, o: 0.45, y: 36, w: 88 },
            { r: -2, o: 0.55, y: 50, w: 92 },
          ].map((b, i) => (
            <div
              key={i}
              className="absolute right-0 top-0 rounded-t border border-slate-600/80 bg-gradient-to-b from-slate-700/90 to-slate-900/90 shadow-md"
              style={{
                width: `${b.w}%`,
                height: 34 + (i % 2) * 4,
                transform: `translate(${b.o * 40}px, ${-b.y}px) rotate(${b.r}deg)`,
                zIndex: i,
              }}
            />
          ))}
          <div
            className="absolute -bottom-1 right-[12%] size-7 rounded-full bg-slate-800/90 ring-2 ring-slate-600"
            style={{ zIndex: 7 }}
            aria-hidden
          />
        </div>
        <p className="pr-2 text-right text-[8px] text-slate-500">積み上がるレシート</p>
      </div>

      <div className="relative z-[1] mx-auto max-w-sm pt-2 text-center">
        <p className="text-4xl" aria-hidden>
          😮‍💨
        </p>
        <p className="mt-1 text-[10px] font-medium uppercase tracking-[0.2em] text-slate-500">Before</p>
        <p className="mt-1 text-xs leading-relaxed text-slate-400">細かい支出が雪だるま。今夜も、また入力…</p>
      </div>

      <p className="sr-only">手書き家計の混乱とレシートの山のイメージ。実データは使用していません。</p>
    </section>
  );
}
