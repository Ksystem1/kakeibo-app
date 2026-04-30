import { useState } from "react";
import {
  DEMO_MEDICAL_TX_COUNT,
  DEMO_MEDICAL_TOTAL_YEN,
  DEMO_MEDICAL_YEAR,
  demoMedicalMatrixRows,
} from "../../data/demoMockData";

function yen(n: number) {
  return `¥${n.toLocaleString("ja-JP")}`;
}

export type DemoSectionClassProps = { className?: string };

/** 医療費控除のデモ（静的プレビュー。DB 非接触） */
export function DemoMedicalDeductionSection({ className }: DemoSectionClassProps) {
  const [demoTap, setDemoTap] = useState(false);
  const typeTotals = demoMedicalMatrixRows.reduce(
    (acc, row) => {
      acc.treatment += row.treatment;
      acc.medicine += row.medicine;
      acc.other += row.other;
      return acc;
    },
    { treatment: 0, medicine: 0, other: 0 },
  );
  const grand = typeTotals.treatment + typeTotals.medicine + typeTotals.other;
  return (
    <section
      className={`rounded-2xl border border-emerald-200/90 bg-gradient-to-b from-white to-emerald-50/40 p-4 shadow-md ring-1 ring-emerald-900/[0.06] md:p-5 ${className ?? ""}`}
    >
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wider text-emerald-700">医療費</p>
          <h2 className="text-base font-bold text-slate-900">医療費控除の集計</h2>
          <p className="mt-1 text-xs leading-relaxed text-slate-600">
            氏名（行）× 区分（列）のマトリックスで一目で確認でき、<strong>国税庁の医療費集計用CSV</strong>
            へ一括で落とせます。
          </p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-right text-xs text-slate-600 shadow-sm">
          <span className="font-semibold text-slate-800">
            {DEMO_MEDICAL_YEAR}年（1月〜12月）
          </span>
          <p className="mt-0.5 font-mono text-[11px] text-slate-500">
            {DEMO_MEDICAL_TX_COUNT}件 / 合計 {yen(DEMO_MEDICAL_TOTAL_YEN)}
          </p>
        </div>
      </div>

      <p className="mb-2 text-center text-[11px] text-slate-500">
        還付を想定した家族3人分のサンプル合計 {yen(DEMO_MEDICAL_TOTAL_YEN)} です
      </p>

      <div className="overflow-x-auto rounded-xl border border-slate-200/90 bg-white shadow-sm">
        <table className="w-full min-w-[520px] border-collapse text-xs">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-100/80 text-slate-700">
              <th className="p-2.5 text-left font-semibold">氏名</th>
              <th className="p-2.5 text-right font-semibold">診療・治療</th>
              <th className="p-2.5 text-right font-semibold">医薬品</th>
              <th className="p-2.5 text-right font-semibold">その他</th>
              <th className="p-2.5 text-right font-semibold">合計</th>
            </tr>
          </thead>
          <tbody>
            {demoMedicalMatrixRows.map((row) => {
              const rowTotal = row.treatment + row.medicine + row.other;
              return (
                <tr key={row.name} className="border-b border-slate-100">
                  <th className="p-2.5 text-left font-medium text-slate-800">{row.name}</th>
                  <td className="p-2.5 text-right tabular-nums text-slate-800">{yen(row.treatment)}</td>
                  <td className="p-2.5 text-right tabular-nums text-slate-800">{yen(row.medicine)}</td>
                  <td className="p-2.5 text-right tabular-nums text-slate-800">{yen(row.other)}</td>
                  <td className="p-2.5 text-right font-semibold tabular-nums text-emerald-800">{yen(rowTotal)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="bg-emerald-50/70 text-slate-900">
              <th className="p-2.5 text-left font-semibold">合計</th>
              <td className="p-2.5 text-right font-semibold tabular-nums">{yen(typeTotals.treatment)}</td>
              <td className="p-2.5 text-right font-semibold tabular-nums">{yen(typeTotals.medicine)}</td>
              <td className="p-2.5 text-right font-semibold tabular-nums">{yen(typeTotals.other)}</td>
              <td className="p-2.5 text-right font-bold tabular-nums text-emerald-900">{yen(grand)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="mt-4">
        <button
          type="button"
          className="w-full rounded-xl bg-gradient-to-r from-teal-600 to-emerald-600 px-4 py-3 text-sm font-bold text-white shadow-lg shadow-teal-600/25 transition hover:from-teal-500 hover:to-emerald-500"
          onClick={() => setDemoTap(true)}
        >
          国税庁フォーマットCSVを書き出す（本番で利用可能）
        </button>
        {demoTap ? (
          <p className="mt-2 rounded-lg border border-teal-200 bg-teal-50/80 px-2 py-1.5 text-center text-[11px] text-teal-900">
            ここで流れを確認したら、本番画面でそのまま使えます。
          </p>
        ) : null}
        <p className="mt-1.5 text-center text-[10px] text-slate-500">取り込みから申告準備まで、同じ流れで迷わず進めます。</p>
      </div>
    </section>
  );
}

/** 最新のレスポンシブUI（カテゴリ / 明細）のイメージ */
export function DemoResponsiveUiSection({ className }: DemoSectionClassProps) {
  return (
    <section
      className={`rounded-2xl border border-slate-200/95 bg-white p-4 shadow-md ring-1 ring-slate-900/[0.04] md:p-5 ${className ?? ""}`}
    >
      <h2 className="text-base font-bold text-slate-900">スッキリしたカテゴリ管理・明細</h2>
      <p className="mt-1 text-xs leading-relaxed text-slate-600">
        横スクロール付きの管理画面・モバイルではカード型の明細など、
        <strong>最近のアップデート</strong>を意識したレイアウトです。文字が潰れず、指でも操作しやすい余白に整えています（イメージ）。
      </p>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <p className="mb-1.5 text-[11px] font-semibold text-slate-500">スマートフォン幅（イメージ）</p>
          <div className="mx-auto w-full max-w-[300px] overflow-hidden rounded-2xl border-4 border-slate-800 bg-slate-100 p-2 shadow-xl">
            <div className="space-y-2 rounded-lg bg-white p-2.5 text-[10px] text-slate-800">
              <p className="font-bold">カテゴリを追加</p>
              <div className="h-7 w-full rounded border border-slate-200 bg-slate-50" />
              <div className="grid grid-cols-2 gap-1.5">
                <div className="h-7 rounded border border-slate-200 bg-slate-50" />
                <div className="h-7 rounded border border-slate-200 bg-slate-50" />
              </div>
              <div className="h-8 w-full rounded-md bg-mint-500/90" />
              <p className="pt-1 text-[9px] text-slate-500">名前欄を広く、操作は下段に──</p>
            </div>
          </div>
        </div>
        <div>
          <p className="mb-1.5 text-[11px] font-semibold text-slate-500">PC（表形式のイメージ）</p>
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-slate-50/80 p-2 shadow-inner">
            <table className="w-full min-w-[480px] border-collapse text-left text-[10px]">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-200/50 text-slate-600">
                  <th className="p-1.5 font-semibold">名前</th>
                  <th className="p-1.5 font-semibold">種別</th>
                  <th className="p-1.5 font-semibold"> </th>
                </tr>
              </thead>
              <tbody>
                {["外食", "旅費", "未分類"].map((n) => (
                  <tr key={n} className="border-b border-slate-100">
                    <td className="p-1.5">
                      <div className="h-5 max-w-[7rem] rounded border border-slate-200 bg-white" />
                    </td>
                    <td className="p-1.5">
                      <div className="h-5 w-14 rounded border border-slate-200 bg-white" />
                    </td>
                    <td className="p-1.5 text-right">
                      <span className="inline-block rounded bg-teal-600/90 px-1.5 py-0.5 text-[9px] text-white">
                        保存
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}

/** 統合取込ハブ（画像/CSV/PDF 自動判別）のイメージ */
export function DemoReceiptImportSection({ className }: DemoSectionClassProps) {
  return (
    <section
      className={`rounded-2xl border border-amber-200/80 bg-gradient-to-b from-amber-50/90 to-stone-50/80 p-4 shadow-md md:p-5 ${className ?? ""}`}
    >
      <h2 className="text-base font-bold text-stone-900">ユニバーサル取込ハブ</h2>
      <p className="mt-1 text-xs leading-relaxed text-stone-600">
        入口はひとつ。画像はレシート解析、CSV/PDF は明細解析へ
        <strong>自動で振り分け</strong>ます。
      </p>
      <div
        className="mt-3 rounded-xl border border-stone-200/90 bg-stone-50/50 p-3"
        style={{ minHeight: "8rem" }}
      >
        <p className="text-center text-xs font-bold text-stone-800">ファイルをここにドロップ</p>
        <p className="mt-2 text-center text-[10px] text-stone-500">何でも置くだけ。形式はアプリが自動判定</p>
        <button
          type="button"
          className="mt-3 w-full rounded-xl bg-gradient-to-r from-teal-500 to-cyan-600 py-2.5 text-sm font-bold text-white shadow-md"
        >
          + おまかせ取込
        </button>
        <p className="mt-2 text-center text-[10px] text-stone-500">JPG/PNG/CSV/PDF すべて対応</p>
      </div>
    </section>
  );
}

export function DemoPlanCompareSection({ className }: DemoSectionClassProps) {
  return (
    <section
      className={`rounded-2xl border border-cyan-200/80 bg-gradient-to-b from-cyan-50/90 via-white to-emerald-50/70 p-4 shadow-md md:p-5 ${className ?? ""}`}
    >
      <h2 className="text-base font-bold text-slate-900">ご利用内容のイメージ</h2>
      <p className="mt-1 text-xs text-slate-600">基本の機能と、拡張できる機能の違いをイメージしやすくまとめています。</p>
      <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full min-w-[460px] border-collapse text-xs">
          <thead>
            <tr className="bg-slate-100 text-slate-700">
              <th className="p-2 text-left">機能</th>
              <th className="p-2 text-center">基本</th>
              <th className="p-2 text-center">拡張</th>
            </tr>
          </thead>
          <tbody>
            {[
              ["レシート取込", "○（枠あり）", "○（無制限）"],
              ["CSV/PDF 取込", "×", "○"],
              ["医療費CSV出力", "×", "○"],
              ["外観のカスタム", "×", "○"],
            ].map((r) => (
              <tr key={r[0]} className="border-t border-slate-100">
                <td className="p-2 text-slate-800">{r[0]}</td>
                <td className="p-2 text-center">{r[1]}</td>
                <td className="p-2 text-center font-semibold text-emerald-700">{r[2]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        className="mt-3 w-full rounded-xl bg-gradient-to-r from-amber-400 to-orange-500 py-2.5 text-sm font-bold text-slate-900 shadow-lg shadow-orange-300/35"
      >
        詳しく見る
      </button>
      <p className="mt-1.5 text-center text-[10px] text-slate-500">使う機能だけを、わかりやすく比較できます。</p>
    </section>
  );
}
