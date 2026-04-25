import { demoPayPayRows } from "../../data/demoMockData";

type Props = { className?: string };

export function DemoPayPayImportPreview({ className }: Props) {
  return (
    <section
      className={`rounded-2xl border border-sky-200/90 bg-gradient-to-b from-sky-50/80 to-white p-4 shadow-md md:p-5 ${className ?? ""}`}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wider text-sky-700">Premium · 新機能</p>
          <h2 className="text-base font-bold text-slate-900">PayPay 利用履歴の一括取込</h2>
          <p className="mt-1 text-xs text-slate-600">CSV を読み込み、店舗名からカテゴリを推定（イメージ）</p>
        </div>
        <span className="rounded-full border border-emerald-300 bg-emerald-100 px-2.5 py-1 text-[11px] font-bold text-emerald-800">
          取込プレビュー完了
        </span>
      </div>
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-inner">
        <table className="w-full min-w-[520px] border-collapse text-left text-xs">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-100/90 text-slate-600">
              <th className="whitespace-nowrap p-2.5 font-semibold">日付</th>
              <th className="p-2.5 font-semibold">明細</th>
              <th className="whitespace-nowrap p-2.5 text-right font-semibold">金額</th>
              <th className="whitespace-nowrap p-2.5 font-semibold">分類</th>
            </tr>
          </thead>
          <tbody>
            {demoPayPayRows.map((r) => (
              <tr key={r.id} className="border-b border-slate-100 last:border-0">
                <td className="whitespace-nowrap p-2.5 font-mono text-slate-600">{r.date}</td>
                <td className="p-2.5 text-slate-900">{r.payee}</td>
                <td className="whitespace-nowrap p-2.5 text-right font-semibold tabular-nums text-slate-900">
                  ¥{r.amount.toLocaleString("ja-JP")}
                </td>
                <td className="whitespace-nowrap p-2.5">
                  <span className="rounded-md bg-sky-100 px-1.5 py-0.5 text-[11px] font-medium text-sky-900">
                    {r.category}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-center text-[10px] text-slate-500">※ 表示はモックです。実際の取込は行いません。</p>
    </section>
  );
}
