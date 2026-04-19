/** 家族チャットの「最後に見たメッセージ ID」（未読バッジ用） */
export const FAMILY_CHAT_SEEN_EVENT = "kakeibo:family-chat-seen";

function storageKey(familyId: number) {
  return `kakeibo_family_chat_seen_${familyId}`;
}

export function getFamilyChatSeenMaxMessageId(familyId: number): number {
  try {
    const v = localStorage.getItem(storageKey(familyId));
    const n = v == null ? 0 : parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function bumpFamilyChatSeenMaxMessageId(familyId: number, maxIdInView: number): void {
  if (!Number.isFinite(familyId) || familyId <= 0) return;
  if (!Number.isFinite(maxIdInView) || maxIdInView <= 0) return;
  try {
    const prev = getFamilyChatSeenMaxMessageId(familyId);
    if (maxIdInView > prev) {
      localStorage.setItem(storageKey(familyId), String(maxIdInView));
      window.dispatchEvent(new Event(FAMILY_CHAT_SEEN_EVENT));
    }
  } catch {
    /* ignore */
  }
}

export function applyFamilyChatSeenFromMessages(
  familyId: number | undefined,
  items: Array<{ id: number }>,
): void {
  if (familyId == null || !Number.isFinite(familyId) || familyId <= 0) return;
  if (!items.length) return;
  const maxId = Math.max(...items.map((m) => m.id));
  bumpFamilyChatSeenMaxMessageId(familyId, maxId);
}
