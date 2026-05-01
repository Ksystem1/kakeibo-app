import {
  FileSpreadsheet,
  HeartPulse,
  LayoutDashboard,
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

export type LoginHeroFeatureListsVariant = "hero" | "dashboard" | "demo";

type Props = {
  /** dashboard: 無料一覧のみ。demo: デモ最終スライド用（無料+Premium 2カラム、本番の主な機能と同じ） */
  variant?: LoginHeroFeatureListsVariant;
};

/**
 * ログイン画面ヒーロー左カラム：無料 / Premium の機能一覧（Tailwind）
 * variant=dashboard：無料ブロックのみ（家族ダッシュボード）
 * 文言は featureLabels と揃える（export_csv / medical_deduction_csv）
 */
/** ログインヒーロー用 Premium 列（ラベル解決をこの子のみで行う） */
function LoginHeroPremiumColumn() {
  const paypayLabel = resolveFeatureDisplayName(FEATURE_EXPORT_CSV, { locale: "ja" });
  const medicalLabel = resolveFeatureDisplayName(FEATURE_MEDICAL_DEDUCTION_CSV, { locale: "ja" });
  return (
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
  );
}

export function LoginHeroFeatureLists({ variant = "hero" }: Props) {
  const isDashboard = variant === "dashboard";

  const titleId = isDashboard ? "dashboard-free-features-title" : "login-hero-features-title";

  const freeListDashboardOnly = (
    <ul className="space-y-2.5 leading-snug text-[#315a85] text-sm">
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
  );

  /** ログイン／トップの無料カードのみ：ダッシュボードをレシートAIより上に表示 */
  const freeListHeroWithDashboard = (
    <ul className="space-y-2.5 leading-snug text-[#315a85] text-[0.86rem]">
      <li className="flex gap-2 min-w-0">
        <LayoutDashboard className="h-4 w-4 shrink-0 mt-0.5 text-[#2e9ff5]" aria-hidden strokeWidth={2} />
        <span>ダッシュボード</span>
      </li>
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
  );

  const freeBlockHero = (
    <div className="min-w-0 rounded-xl border border-white/60 bg-white/40 px-3 py-3 shadow-md shadow-slate-900/5 backdrop-blur-sm">
      <div className="flex items-center gap-2 mb-2.5">
        <Sparkles className="h-4 w-4 shrink-0 text-[#2e9ff5]" aria-hidden strokeWidth={2.25} />
        <span className="font-bold text-[#0a2f5c] text-[0.82rem]">無料（登録後）</span>
      </div>
      {freeListHeroWithDashboard}
    </div>
  );

  /** 見出し・説明をレシートAI行の直上（カード内先頭）に置く */
  const freeBlockDashboard = (
    <div className="min-w-0 rounded-lg border border-slate-200/90 bg-slate-50/80 px-3 py-3 sm:px-4 md:max-w-xl">
      <h2
        id={titleId}
        className="text-sm font-bold text-slate-800 tracking-tight mb-1.5"
      >
        無料で使える機能
      </h2>
      <p className="text-sm text-slate-600 mb-3 leading-relaxed">
        ログイン済みのすべてのユーザーが、追加料金なしで利用できます。
      </p>
      <div className="flex items-center gap-2 mb-2.5">
        <Sparkles className="h-4 w-4 shrink-0 text-[#2e9ff5]" aria-hidden strokeWidth={2.25} />
        <span className="font-bold text-[#0a2f5c] text-sm">無料（登録後）</span>
      </div>
      {freeListDashboardOnly}
    </div>
  );

  if (isDashboard) {
    return (
      <section className="w-full text-left" aria-labelledby={titleId}>
        {freeBlockDashboard}
      </section>
    );
  }

  if (variant === "demo") {
    return (
      <section
        className="w-full max-w-4xl mx-auto text-left"
        aria-labelledby="demo-feature-compare-title"
      >
        <h2
          id="demo-feature-compare-title"
          className="text-[0.78rem] font-bold uppercase tracking-[0.12em] text-[#315a85]/90 mb-2"
        >
          主な機能
        </h2>
        <p className="text-[0.88rem] leading-relaxed text-[#315a85] mb-4">
          無料で始められることと、<strong className="font-semibold text-[#0a2f5c]">Premium</strong>
          でさらに使えることを一覧できます。
        </p>
        <div className="grid min-w-0 grid-cols-1 gap-4 sm:gap-5 sm:grid-cols-2">
          {freeBlockHero}
          <LoginHeroPremiumColumn />
        </div>
        <p className="mt-3 text-center text-[0.7rem] text-slate-500">
          左＝登録後すぐ使える無料枠、右＝有料の Premium 枠（イメージ）。実際の利用可否は契約内容に従います。
        </p>
      </section>
    );
  }

  return (
    <section
      className="w-full max-w-xl mx-auto mt-5 px-1 sm:px-2 text-left"
      aria-labelledby={titleId}
    >
      <h2
        id={titleId}
        className="text-[0.78rem] font-bold uppercase tracking-[0.12em] text-[#315a85]/90 mb-3 text-center sm:text-left"
      >
        主な機能
      </h2>
      <p className="text-[0.88rem] leading-relaxed text-[#315a85] mb-4 text-center sm:text-left">
        無料で始められることと、<strong className="font-semibold text-[#0a2f5c]">Premium</strong>
        でさらに使えることを一覧できます。
      </p>

      <div className="grid min-w-0 grid-cols-1 gap-4 sm:gap-5 sm:grid-cols-2">
        {freeBlockHero}

        <LoginHeroPremiumColumn />
      </div>
    </section>
  );
}
