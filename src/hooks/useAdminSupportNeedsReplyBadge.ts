import { useCallback, useEffect, useState } from "react";
import { getAdminSupportChatFamilies, type AdminSupportChatFamilyRow } from "../lib/api";

/** 管理者が返信すべき状態（最新が利用者側） */
export function familyNeedsAdminReply(row: AdminSupportChatFamilyRow): boolean {
  if (typeof row.has_unread === "boolean") return row.has_unread;
  return Boolean(row.last_message && !row.last_message.is_staff);
}

export const SUPPORT_CHAT_ADMIN_QUEUE_EVENT = "kakeibo:support-chat-admin-queue";

export function notifyAdminSupportQueueChanged(): void {
  window.dispatchEvent(new Event(SUPPORT_CHAT_ADMIN_QUEUE_EVENT));
}

/**
 * 要返信の家族数（最新メッセージが is_staff でない家族）。
 */
export function useAdminSupportNeedsReplyBadge(opts: {
  token: string | null;
  enabled?: boolean;
}) {
  const { token, enabled = true } = opts;
  const [needsReplyCount, setNeedsReplyCount] = useState(0);

  const refresh = useCallback(async () => {
    if (!token || !enabled) {
      setNeedsReplyCount(0);
      return;
    }
    try {
      const res = await getAdminSupportChatFamilies();
      const items = Array.isArray(res.items) ? res.items : [];
      setNeedsReplyCount(items.filter((f) => familyNeedsAdminReply(f)).length);
    } catch {
      setNeedsReplyCount(0);
    }
  }, [token, enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const h = () => {
      void refresh();
    };
    window.addEventListener(SUPPORT_CHAT_ADMIN_QUEUE_EVENT, h);
    return () => window.removeEventListener(SUPPORT_CHAT_ADMIN_QUEUE_EVENT, h);
  }, [refresh]);

  return { needsReplyCount, refresh };
}
