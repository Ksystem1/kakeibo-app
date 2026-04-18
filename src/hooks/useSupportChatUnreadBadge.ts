import { useCallback, useEffect, useState } from "react";
import { getSupportChatMessages } from "../lib/api";
import {
  getSupportChatSeenMaxMessageId,
  SUPPORT_CHAT_SEEN_EVENT,
} from "../lib/supportChatSeen";

/**
 * 運営（is_staff）からの最新メッセージが、チャット画面で最後に見た ID より新しいとき true。
 */
export function useSupportChatUnreadBadge(opts: {
  token: string | null;
  familyId: number | null | undefined;
  enabled?: boolean;
}) {
  const { token, familyId, enabled = true } = opts;
  const [unread, setUnread] = useState(false);

  const refresh = useCallback(async () => {
    if (!token || !enabled || familyId == null || !Number.isFinite(familyId)) {
      setUnread(false);
      return;
    }
    try {
      const { items } = await getSupportChatMessages({
        family_id: familyId,
        limit: 1,
      });
      const latest = items.length > 0 ? items[items.length - 1] : null;
      const seen = getSupportChatSeenMaxMessageId(familyId);
      setUnread(Boolean(latest && latest.is_staff && latest.id > seen));
    } catch {
      setUnread(false);
    }
  }, [token, familyId, enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const h = () => {
      void refresh();
    };
    window.addEventListener(SUPPORT_CHAT_SEEN_EVENT, h);
    return () => window.removeEventListener(SUPPORT_CHAT_SEEN_EVENT, h);
  }, [refresh]);

  return { unread, refresh };
}
