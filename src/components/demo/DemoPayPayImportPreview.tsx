import { demoImportPreviewRows } from "../../data/demoMockData";

type Props = { className?: string };

export function DemoPayPayImportPreview({ className }: Props) {
  return (
    <section
      className={`rounded-2xl border border-sky-200/90 bg-gradient-to-b from-sky-50/80 to-white p-4 shadow-md md:p-5 ${className ?? ""}`}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wider text-sky-700">Auto Import</p>
          <h2 className="text-base font-bold text-slate-900">銀行・カード・PayPayを自動判別で一括取込</h2>
        </div>
        <span className="rounded-full border border-emerald-300 bg-emerald-100 px-2.5 py-1 text-[11px] font-bold text-emerald-800">
          自動分類まで完了
        </span>
      </div>
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-inner">
        <table className="w-full min-w-[520px] border-collapse text-left text-xs">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-100/90 text-slate-600">
              <th className="whitespace-nowrap p-2.5 font-semibold">取込元</th>
              <th className="whitespace-nowrap p-2.5 font-semibold">日付</th>
              <th className="p-2.5 font-semibold">明細</th>
              <th className="whitespace-nowrap p-2.5 text-right font-semibold">金額</th>
              <th className="whitespace-nowrap p-2.5 font-semibold">分類</th>
            </tr>
          </thead>
          <tbody>
            {demoImportPreviewRows.map((r) => (
              <tr key={r.id} className="border-b border-slate-100 last:border-0">
                <td className="whitespace-nowrap p-2.5 text-slate-700">{r.source}</td>
                <td className="whitespace-nowrap p-2.5 font-mono text-slate-600">{r.date}</td>
                <td className="p-2.5 text-slate-900">{r.description}</td>
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
      <p className="mt-2 text-center text-[10px] text-slate-500">武蔵野銀行・エポス・PayPayを同時に読み込み、食費/日用品/医療まで即分類。</p>
    </section>
  );
}
