/** localStorage + 同一タブ向け通知（未読バッジ用） */
export const SUPPORT_CHAT_SEEN_EVENT = "kakeibo:support-chat-seen";

function storageKey(familyId: number) {
  return `kakeibo_support_chat_seen_${familyId}`;
}

export function getSupportChatSeenMaxMessageId(familyId: number): number {
  try {
    const v = localStorage.getItem(storageKey(familyId));
    const n = v == null ? 0 : parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function bumpSupportChatSeenMaxMessageId(familyId: number, maxIdInView: number): void {
  if (!Number.isFinite(familyId) || familyId <= 0) return;
  if (!Number.isFinite(maxIdInView) || maxIdInView <= 0) return;
  try {
    const prev = getSupportChatSeenMaxMessageId(familyId);
    if (maxIdInView > prev) {
      localStorage.setItem(storageKey(familyId), String(maxIdInView));
      window.dispatchEvent(new Event(SUPPORT_CHAT_SEEN_EVENT));
    }
  } catch {
    /* ignore */
  }
}

export function applySupportChatSeenFromMessages(
  familyId: number | undefined,
  items: Array<{ id: number }>,
): void {
  if (familyId == null || !Number.isFinite(familyId) || familyId <= 0) return;
  if (!items.length) return;
  const maxId = Math.max(...items.map((m) => m.id));
  bumpSupportChatSeenMaxMessageId(familyId, maxId);
}
