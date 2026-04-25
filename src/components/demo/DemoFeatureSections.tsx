import { useState } from "react";
import {
  DEMO_MEDICAL_TX_COUNT,
  DEMO_MEDICAL_TOTAL_YEN,
  DEMO_MEDICAL_YEAR,
  demoMedicalByPatient,
  demoMedicalByType,
} from "../../data/demoMockData";

function yen(n: number) {
  return `¥${n.toLocaleString("ja-JP")}`;
}

/** 医療費控除（プレミアム）— 静的プレビュー。DB 非接触 */
export function DemoMedicalDeductionSection() {
  const [demoTap, setDemoTap] = useState(false);
  return (
    <section className="rounded-2xl border border-emerald-200/90 bg-gradient-to-b from-white to-emerald-50/40 p-4 shadow-md ring-1 ring-emerald-900/[0.06] md:p-5">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wider text-emerald-700">Premium</p>
          <h2 className="text-base font-bold text-slate-900">医療費控除の集計</h2>
          <p className="mt-1 text-xs leading-relaxed text-slate-600">
            氏名別・区分別の合計が一目で分かり、<strong>国税庁の医療費集計用CSV</strong>
            へ一括で落とせます。確定申告の手間を大きく減らせます（デモ表示・ダウンロードなし）。
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

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="rounded-xl border border-slate-200/90 bg-white p-3 shadow-sm">
          <h3 className="text-xs font-bold text-slate-800">氏名別</h3>
          <ul className="mt-2 space-y-1.5 text-xs">
            {demoMedicalByPatient.map((r) => (
              <li
                key={r.name}
                className="flex items-baseline justify-between gap-2 rounded-md bg-slate-50 px-2 py-1.5"
              >
                <span className="text-slate-700">{r.name}</span>
                <span className="font-semibold tabular-nums text-slate-900">{yen(r.amount)}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-xl border border-slate-200/90 bg-white p-3 shadow-sm">
          <h3 className="text-xs font-bold text-slate-800">区分別</h3>
          <ul className="mt-2 space-y-1.5 text-xs">
            {demoMedicalByType.map((r) => (
              <li
                key={r.label}
                className="flex items-baseline justify-between gap-2 rounded-md bg-slate-50 px-2 py-1.5"
              >
                <span className="text-slate-700">{r.label}</span>
                <span className="font-semibold tabular-nums text-slate-900">{yen(r.amount)}</span>
              </li>
            ))}
          </ul>
        </div>
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
            デモのためダウンロードは行いません。本番の「医療費集計」画面で同じ操作ができます。
          </p>
        ) : null}
        <p className="mt-1.5 text-center text-[10px] text-slate-500">※ この画面はモックです。DB やファイルは更新されません。</p>
      </div>
    </section>
  );
}

/** 最新のレスポンシブUI（カテゴリ / 明細）のイメージ */
export function DemoResponsiveUiSection() {
  return (
    <section className="rounded-2xl border border-slate-200/95 bg-white p-4 shadow-md ring-1 ring-slate-900/[0.04] md:p-5">
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

/** レシート取込（最新余白）のイメージ */
export function DemoReceiptImportSection() {
  return (
    <section className="rounded-2xl border border-amber-200/80 bg-gradient-to-b from-amber-50/90 to-stone-50/80 p-4 shadow-md md:p-5">
      <h2 className="text-base font-bold text-stone-900">レシート取込：撮るだけ</h2>
      <p className="mt-1 text-xs leading-relaxed text-stone-600">
        家計簿アプリ内のレシート画面と同じトーンで、<strong>余白を抑えたモバイル向けヘッダー</strong>
        からすぐ取り込めます（デモ表示）。
      </p>
      <div
        className="mt-3 rounded-xl border border-stone-200/90 bg-stone-50/50 p-3"
        style={{ minHeight: "8rem" }}
      >
        <p className="text-center text-xs font-bold text-stone-800">レシート・明細取込</p>
        <p className="mt-2 text-center text-[10px] text-stone-500">レシートを撮影または画像を選択</p>
        <button
          type="button"
          className="mt-3 w-full rounded-xl bg-gradient-to-r from-teal-500 to-cyan-600 py-2.5 text-sm font-bold text-white shadow-md"
        >
          写真・データ取込
        </button>
        <p className="mt-2 text-center text-[10px] text-stone-500">
          銀行の明細用CSVは
          <span className="text-teal-700">銀行・カード明細取込</span> へ
        </p>
      </div>
    </section>
  );
}
