import { useCallback, useEffect, useState } from "react";
import { getFamilyChatMessages } from "../lib/api";
import {
  getFamilyChatSeenMaxMessageId,
  FAMILY_CHAT_SEEN_EVENT,
} from "../lib/familyChatSeen";

/** 他者からの最新メッセージが、チャットで最後に見た ID より新しいとき true */
export function useFamilyChatUnreadBadge(opts: {
  token: string | null;
  userId: number | null | undefined;
  familyId: number | null | undefined;
  enabled?: boolean;
}) {
  const { token, userId, familyId, enabled = true } = opts;
  const [unread, setUnread] = useState(false);

  const refresh = useCallback(async () => {
    if (
      !token ||
      !enabled ||
      userId == null ||
      !Number.isFinite(userId) ||
      familyId == null ||
      !Number.isFinite(familyId)
    ) {
      setUnread(false);
      return;
    }
    try {
      const { items } = await getFamilyChatMessages({
        family_id: familyId,
        limit: 1,
      });
      const latest = items.length > 0 ? items[items.length - 1] : null;
      const seen = getFamilyChatSeenMaxMessageId(familyId);
      setUnread(
        Boolean(
          latest &&
            latest.sender_user_id !== userId &&
            latest.id > seen,
        ),
      );
    } catch {
      setUnread(false);
    }
  }, [token, userId, familyId, enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const h = () => {
      void refresh();
    };
    window.addEventListener(FAMILY_CHAT_SEEN_EVENT, h);
    return () => window.removeEventListener(FAMILY_CHAT_SEEN_EVENT, h);
  }, [refresh]);

  return { unread, refresh };
}
