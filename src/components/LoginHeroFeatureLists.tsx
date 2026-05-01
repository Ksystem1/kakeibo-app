import {
  FileSpreadsheet,
  HeartPulse,
  MessageCircle,
  ScanLine,
  Smartphone,
  Sparkles,
  UsersRound,
} from "lucide-react";
import {
  FEATURE_EXPORT_CSV,
  FEATURE_MEDICAL_DEDUCTION_CSV,
} from "../lib/api";
import { resolveFeatureDisplayName } from "../i18n/featureLabels";

/**
 * ログイン画面ヒーロー左カラム用：無料 / Premium の機能一覧（Tailwind）
 * 文言は featureLabels と揃える（export_csv / medical_deduction_csv）
 */
export function LoginHeroFeatureLists() {
  const paypayLabel = resolveFeatureDisplayName(FEATURE_EXPORT_CSV, { locale: "ja" });
  const medicalLabel = resolveFeatureDisplayName(FEATURE_MEDICAL_DEDUCTION_CSV, { locale: "ja" });

  return (
    <section
      className="w-full max-w-xl mx-auto mt-5 px-1 sm:px-2 text-left"
      aria-labelledby="login-hero-features-title"
    >
      <h2
        id="login-hero-features-title"
        className="text-[0.78rem] font-bold uppercase tracking-[0.12em] text-[#315a85]/90 mb-3 text-center sm:text-left"
      >
        主な機能
      </h2>
      <p className="text-[0.88rem] leading-relaxed text-[#315a85] mb-4 text-center sm:text-left">
        無料で始められることと、<strong className="font-semibold text-[#0a2f5c]">Premium</strong>
        でさらに使えることを一覧できます。
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-5 min-w-0">
        {/* 無料 */}
        <div className="min-w-0 rounded-xl border border-white/60 bg-white/40 px-3 py-3 shadow-md shadow-slate-900/5 backdrop-blur-sm">
          <div className="flex items-center gap-2 mb-2.5">
            <Sparkles className="h-4 w-4 shrink-0 text-[#2e9ff5]" aria-hidden strokeWidth={2.25} />
            <span className="text-[0.82rem] font-bold text-[#0a2f5c]">無料（登録後）</span>
          </div>
          <ul className="space-y-2.5 text-[0.86rem] leading-snug text-[#315a85]">
            <li className="flex gap-2 min-w-0">
              <ScanLine className="h-4 w-4 shrink-0 mt-0.5 text-[#2e9ff5]" aria-hidden strokeWidth={2} />
              <span>レシートAI（撮影・解析）</span>
            </li>
            <li className="flex gap-2 min-w-0">
              <UsersRound className="h-4 w-4 shrink-0 mt-0.5 text-[#2e9ff5]" aria-hidden strokeWidth={2} />
              <span>家族で家計簿を共有</span>
            </li>
            <li className="flex gap-2 min-w-0">
              <MessageCircle className="h-4 w-4 shrink-0 mt-0.5 text-[#2e9ff5]" aria-hidden strokeWidth={2} />
              <span>サポートチャット</span>
            </li>
          </ul>
        </div>

        {/* Premium */}
        <div className="min-w-0 rounded-xl border border-sky-200/80 bg-sky-50/40 px-3 py-3 shadow-md shadow-sky-900/10 backdrop-blur-sm">
          <div className="flex items-center gap-2 mb-2.5 flex-wrap">
            <FileSpreadsheet className="h-4 w-4 shrink-0 text-[#0a2f5c]" aria-hidden strokeWidth={2.25} />
            <span className="text-[0.82rem] font-bold text-[#0a2f5c]">Premium</span>
            <span className="text-[0.72rem] font-semibold uppercase tracking-wider text-sky-700 border border-sky-300/80 rounded-full px-2 py-0.5 bg-white/60">
              有料プラン
            </span>
          </div>
          <ul className="space-y-3 text-[0.86rem] leading-snug text-[#315a85]">
            <li className="flex gap-2 min-w-0 items-start">
              <Smartphone className="h-4 w-4 shrink-0 mt-0.5 text-[#0a2f5c]" aria-hidden strokeWidth={2} />
              <span className="min-w-0 flex-1">
                <span className="block">{paypayLabel}</span>
                <span
                  className="inline-flex mt-1 items-center rounded-full border border-sky-300/70 bg-white/80 px-2 py-0.5 text-[0.62rem] font-bold uppercase tracking-[0.06em] text-sky-800"
                  aria-label="Premium で利用可能"
                >
                  Premium
                </span>
              </span>
            </li>
            <li className="flex gap-2 min-w-0 items-start">
              <HeartPulse className="h-4 w-4 shrink-0 mt-0.5 text-[#0a2f5c]" aria-hidden strokeWidth={2} />
              <span className="min-w-0 flex-1">
                <span className="block break-words">{medicalLabel}</span>
                <span
                  className="inline-flex mt-1 items-center rounded-full border border-sky-300/70 bg-white/80 px-2 py-0.5 text-[0.62rem] font-bold uppercase tracking-[0.06em] text-sky-800"
                  aria-label="Premium で利用可能"
                >
                  Premium
                </span>
              </span>
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}
