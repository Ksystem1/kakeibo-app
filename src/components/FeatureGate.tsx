import { Lock } from "lucide-react";
import { Fragment, type CSSProperties, type ReactNode } from "react";
import { useFeaturePermissions } from "../context/FeaturePermissionContext";

export type FeatureGateMode = "hide" | "lock";

type Props = {
  /** feature_permissions.feature_key と一致（例: receipt_ai） */
  feature: string;
  children: ReactNode;
  /** mode=lock のとき未許可で表示する内容（省略時は鍵アイコン＋薄いオーバーレイ） */
  lockedFallback?: ReactNode;
  mode?: FeatureGateMode;
  className?: string;
  style?: CSSProperties;
};

/**
 * プラン別機能権限に応じて子を出し分け。
 * - hide: 未許可かつ判定完了後は非表示
 * - lock: 未許可かつ判定完了後はロック表示（クリックは透過しないので親で制御）
 */
export function FeatureGate({
  feature,
  children,
  lockedFallback,
  mode = "hide",
  className,
  style,
}: Props) {
  const { loading, allowedFor } = useFeaturePermissions();
  const allowed = allowedFor(feature);
  const blocked = !loading && !allowed;

  if (mode === "hide") {
    if (blocked) return null;
    if (className || style) {
      return (
        <div className={className} style={style}>
          {children}
        </div>
      );
    }
    return <Fragment>{children}</Fragment>;
  }

  if (blocked) {
    if (lockedFallback != null) {
      return <div className={className} style={style}>{lockedFallback}</div>;
    }
    return (
      <div
        className={className}
        style={{
          position: "relative",
          display: "inline-block",
          minHeight: "2rem",
          minWidth: "2rem",
          ...style,
        }}
        title="この機能は現在ご利用いただけません"
      >
        <div style={{ pointerEvents: "none", opacity: 0.45 }}>{children}</div>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "color-mix(in srgb, var(--bg-card) 60%, transparent)",
            borderRadius: 8,
            pointerEvents: "auto",
            cursor: "not-allowed",
          }}
        >
          <Lock size={20} aria-hidden strokeWidth={2.2} />
        </div>
      </div>
    );
  }

  if (className || style) {
    return (
      <div className={className} style={style}>
        {children}
      </div>
    );
  }
  return <Fragment>{children}</Fragment>;
}
