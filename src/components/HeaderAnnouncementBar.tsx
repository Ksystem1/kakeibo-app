import { useMemo } from "react";

type Props = {
  text: string;
};

/**
 * ヘッダー中央: 1 行お知らせ（右→左へ流れるマルquee）。
 * `prefers-reduced-motion` のときはアニメーションなし・省略表示。
 */
export function HeaderAnnouncementBar({ text }: Props) {
  const trimmed = text.trim();
  const segment = useMemo(() => {
    if (!trimmed) return "";
    return `${trimmed}\u3000\u3000`;
  }, [trimmed]);

  const durationSec = useMemo(() => {
    if (!trimmed) return 20;
    return Math.min(48, Math.max(12, trimmed.length * 0.38));
  }, [trimmed]);

  if (!trimmed) {
    return (
      <div
        className="header-announcement-spacer"
        style={{ flex: 1, minWidth: 0 }}
        aria-hidden
      />
    );
  }

  return (
    <div
      className="header-announcement"
      role="status"
      aria-live="polite"
      aria-label="お知らせ"
    >
      <div
        className="header-announcement__track"
        data-animated="true"
        style={{ animationDuration: `${durationSec}s` }}
      >
        <span className="header-announcement__text">{segment}</span>
        <span className="header-announcement__text" aria-hidden="true">
          {segment}
        </span>
      </div>
    </div>
  );
}
