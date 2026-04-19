import type { ChatReadState, SupportChatMessage } from "./api";

/** 運営サポート: 自分の送信メッセージについて、送信者以外に既読が付いたか */
export function supportUserOutgoingReadLabel(
  m: SupportChatMessage,
  selfUserId: number,
  readStates: ChatReadState[],
): string | null {
  if (m.is_staff || m.sender_user_id !== selfUserId) return null;
  const others = readStates.filter((r) => r.user_id !== m.sender_user_id);
  if (others.length === 0) return null;
  const all = others.every((r) => r.last_read_message_id >= m.id);
  return all ? "既読" : null;
}

/** 管理画面: スタッフ送信について、家族メンバー全員が読んだか */
export function supportStaffOutgoingReadLabel(
  m: SupportChatMessage,
  memberUserIds: number[],
  readStates: ChatReadState[],
): string | null {
  if (!m.is_staff) return null;
  if (!memberUserIds.length) return null;
  const map = new Map(readStates.map((r) => [r.user_id, r.last_read_message_id]));
  const all = memberUserIds.every((uid) => (map.get(uid) ?? 0) >= m.id);
  return all ? "既読" : null;
}

/** 家族チャット: 自分の送信について、家族の他メンバー全員が読んだか */
export function familyOutgoingReadLabel(
  m: SupportChatMessage,
  selfUserId: number,
  memberUserIds: number[],
  readStates: ChatReadState[],
): string | null {
  if (m.sender_user_id !== selfUserId) return null;
  const others = memberUserIds.filter((id) => id !== selfUserId);
  if (others.length === 0) return null;
  const map = new Map(readStates.map((r) => [r.user_id, r.last_read_message_id]));
  const all = others.every((uid) => (map.get(uid) ?? 0) >= m.id);
  return all ? "既読" : null;
}
