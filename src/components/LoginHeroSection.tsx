import { memo, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AuthHeroAside } from "./AuthHeroAside";
import { LoginHeroFeatureLists } from "./LoginHeroFeatureLists";
import { MonitorRecruitmentLandingPromo } from "./MonitorRecruitmentLandingPromo";
import { useLoginHeroLiveCount } from "../hooks/useLoginHeroLiveCount";
import styles from "./LoginScreen.module.css";

type Props = {
  onRequestDemoExit: () => void;
};

/**
 * ログイン左カラムのみ。user-stats の更新でログインフォーム側の再レンダーが起きないよう親から分離（React.memo）
 */
function LoginHeroSectionImpl({ onRequestDemoExit }: Props) {
  const navigate = useNavigate();
  const { registeredDisplay, avatarLetters, avatarJiggle, isProvisional } = useLoginHeroLiveCount();

  const registeredLabel = useMemo(
    () => `+${Math.floor(registeredDisplay).toLocaleString("ja-JP")}`,
    [registeredDisplay],
  );

  return (
    <AuthHeroAside>
      <span className={styles.badge}>KAKEIBO ✨</span>
      <div className={styles.heroBody}>
        <section className={styles.heroText}>
          <h1 className={styles.heroTitle}>みんなの家計簿</h1>
          <p className={styles.heroDesc}>
            家計簿を共有できます。医療費控除の集計・固定費・おまかせ取込のイメージは
            <strong className={styles.heroDescCtaEm}>「デモを見る」</strong>
            で体験できます。
          </p>
        </section>
      </div>
      <LoginHeroFeatureLists />
      <MonitorRecruitmentLandingPromo />
      <div className={styles.heroCtaBlock}>
        <Link
          to="/demo-dashboard"
          className={styles.demoCta}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) {
              navigate("/demo-dashboard");
              return;
            }
            onRequestDemoExit();
          }}
        >
          <span className={styles.demoCtaIconBubble} aria-hidden>
            🎬
          </span>
          デモを見る
        </Link>
        <p className={styles.heroMicroCopy}>登録不要で30秒で体験できます</p>
      </div>
      <div
        className={styles.heroStatsBlock}
        aria-label="会員数と稼働状況。タブ非表示中は再取得を休止。フォーカス復帰で最新化。"
      >
        <p className={styles.heroStatLine}>
          累計{" "}
          <span
            className={`${styles.heroStatRegNum}${isProvisional ? ` ${styles.heroStatRegNumProvisional}` : ""}`}
            aria-live="polite"
            data-provisional={isProvisional ? "true" : undefined}
            aria-busy={isProvisional || undefined}
          >
            {registeredLabel}
          </span>{" "}
          名が登録済み
        </p>
        <div className={styles.heroStatsLiveRow}>
          <div
            className={styles.heroAvatars}
            aria-hidden
            data-refresh={avatarJiggle}
          >
            {avatarLetters.map((ch, i) => (
              <span key={i} className={styles.heroAvatar}>
                {ch}
              </span>
            ))}
          </div>
          <p className={styles.heroStatLine}>
            <span className={styles.heroOnDotWrap} aria-hidden>
              <span className={styles.heroOnDot} />
            </span>
            稼働中
          </p>
        </div>
      </div>
    </AuthHeroAside>
  );
}

export const LoginHeroSection = memo(LoginHeroSectionImpl);
