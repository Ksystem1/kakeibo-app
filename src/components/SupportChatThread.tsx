import type { ReactNode } from "react";
import type { SupportChatMessage } from "../lib/api";
import styles from "./SupportChat.module.css";

function formatChatTime(iso: string | null | undefined): string {
  if (iso == null || iso === "") return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

type Variant = "user" | "admin";

function isUserSide(variant: Variant, m: SupportChatMessage): boolean {
  if (variant === "user") return !m.is_staff;
  return m.is_staff;
}

export function SupportChatThread(props: {
  variant: Variant;
  items: SupportChatMessage[];
  messageActions?: (m: SupportChatMessage) => ReactNode;
}) {
  const { variant, items, messageActions } = props;
  return (
    <div className={styles.thread}>
      {items.map((m) => {
        const userSide = isUserSide(variant, m);
        return (
          <div
            key={m.id}
            className={`${styles.row} ${userSide ? styles.rowUser : styles.rowStaff}`}
          >
            <div className={styles.wrap}>
              <div
                className={`${styles.bubble} ${userSide ? styles.bubbleUser : styles.bubbleStaff}`}
              >
                {m.body}
                {m.is_important ? (
                  <span className={styles.importantBadge} title="重要（メモ）">
                    ★
                  </span>
                ) : null}
              </div>
              <div className={styles.meta}>
                {formatChatTime(m.created_at)}
                {messageActions ? messageActions(m) : null}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
