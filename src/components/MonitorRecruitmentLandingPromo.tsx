import { memo } from "react";
import { Link } from "react-router-dom";
import monitorRecruitPromoUrl from "../assets/monitor-recruit-promo.svg?url";
import { usePublicMonitorSettings } from "../hooks/usePublicMonitorSettings";
import styles from "./LoginScreen.module.css";

function MonitorRecruitmentLandingPromoImpl() {
  const { settings, loading, showLimitedLandingPromo } = usePublicMonitorSettings();

  if (loading) return null;
  if (!showLimitedLandingPromo) return null;

  const cap = settings.monitor_recruitment_capacity;
  const rem = settings.monitor_recruitment_remaining ?? 0;
  const filled = settings.monitor_recruitment_filled;
  const pct = cap > 0 ? Math.min(100, Math.round((filled / cap) * 100)) : 0;
  const closed = rem <= 0;

  return (
    <div className={styles.monitorPromoWrap}>
      <Link
        to="/register"
        className={`${styles.monitorPromoCard}${closed ? ` ${styles.monitorPromoCardClosed}` : ""}`}
        aria-label={closed ? "モニター募集（定員に達しました）" : "モニター募集の詳細を見て新規登録へ"}
      >
        <div className={styles.monitorPromoVisual} aria-hidden>
          <img
            src={monitorRecruitPromoUrl}
            alt=""
            width={200}
            height={134}
            className={styles.monitorPromoImg}
            loading="lazy"
            decoding="async"
          />
        </div>
        <div className={styles.monitorPromoBody}>
          <p className={styles.monitorPromoKicker}>先着 {cap} 名限定</p>
          <h2 className={styles.monitorPromoTitle}>モニター募集</h2>
          <p className={styles.monitorPromoText}>{settings.monitor_recruitment_text}</p>
          <div className={styles.monitorPromoMeter} aria-label={`申し込み ${filled} 名、残り ${rem} 名`}>
            <div className={styles.monitorPromoMeterLabels}>
              <span>残り</span>
              <span className={styles.monitorPromoRemain}>
                {closed ? "—" : `${rem}`}
                <span className={styles.monitorPromoRemainUnit}>名</span>
              </span>
            </div>
            <div className={styles.monitorPromoBarTrack}>
              <div
                className={styles.monitorPromoBarFill}
                style={{ width: `${closed ? 100 : pct}%` }}
              />
            </div>
            <p className={styles.monitorPromoMeterFoot}>
              {closed
                ? "定員に達しました（募集終了）"
                : `${filled.toLocaleString("ja-JP")} / ${cap.toLocaleString("ja-JP")} 名がエントリー済み`}
            </p>
          </div>
          <span className={styles.monitorPromoCta}>
            {closed ? "新規登録はこちら" : "無料で新規登録"}
            <span aria-hidden> →</span>
          </span>
        </div>
      </Link>
    </div>
  );
}

export const MonitorRecruitmentLandingPromo = memo(MonitorRecruitmentLandingPromoImpl);
