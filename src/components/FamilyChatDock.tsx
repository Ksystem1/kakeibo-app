import { Mail, MessageCircle, Rabbit, Send, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";
import {
  deleteFamilyChatMessage,
  getFamilyChatMessages,
  getFamilyMembers,
  patchFamilyChatMessage,
  postFamilyChatMessage,
  postFamilyChatRead,
  type ChatReadState,
  type SupportChatMessage,
} from "../lib/api";
import { familyOutgoingReadLabel } from "../lib/chatReadReceipt";
import {
  applyFamilyChatSeenFromMessages,
  bumpFamilyChatSeenMaxMessageId,
} from "../lib/familyChatSeen";
import { useFamilyChatUnreadBadge } from "../hooks/useFamilyChatUnreadBadge";

type Props = {
  /** ヘッダー文言（親用 / 子用で差し替え可） */
  title?: string;
  /** 子ども画面: 大きな FAB とアイコンをやわらかく */
  variant?: "default" | "kid";
  /**
   * AI アドバイザー（右下・z 高め）と FAB が重ならないよう、家族チャット FAB を左へ寄せる。
   * ログイン後の一般レイアウトで true にする想定。
   */
  fabClearAiAdvisor?: boolean;
};

function formatChatTime(iso: string | null | undefined) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(11, 16);
  const mo = String(d.getMonth() + 1);
  const da = String(d.getDate());
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${mo}/${da} ${hh}:${mm}`;
}

export function FamilyChatDock({
  title = "家族チャット",
  variant = "default",
  fabClearAiAdvisor = false,
}: Props) {
  const { token, user } = useAuth();
  const userId = user?.id;
  const familyId =
    user?.familyId != null && Number.isFinite(Number(user.familyId))
      ? Number(user.familyId)
      : null;

  const { unread, refresh: refreshUnread } = useFamilyChatUnreadBadge({
    token,
    userId,
    familyId,
    enabled: Boolean(token && familyId),
  });

  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<SupportChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [nameByUserId, setNameByUserId] = useState<Map<number, string>>(() => new Map());
  const [memberUserIds, setMemberUserIds] = useState<number[]>([]);
  const [readStates, setReadStates] = useState<ChatReadState[]>([]);
  const [isOwnerMember, setIsOwnerMember] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const itemsRef = useRef<SupportChatMessage[]>([]);
  const lastPostedReadRef = useRef(0);

  const canUse = Boolean(token && familyId && userId != null);

  const loadMembers = useCallback(async () => {
    if (!token) return;
    try {
      const res = await getFamilyMembers();
      const m = new Map<number, string>();
      const ids: number[] = [];
      let owner = false;
      for (const it of res.items ?? []) {
        const id = Number(it.id);
        if (!Number.isFinite(id)) continue;
        ids.push(id);
        if (userId != null && id === userId && String(it.role ?? "").toLowerCase() === "owner") {
          owner = true;
        }
        const label =
          it.display_name != null && String(it.display_name).trim() !== ""
            ? String(it.display_name).trim()
            : it.email
              ? String(it.email).split("@")[0]
              : `ユーザー${id}`;
        m.set(id, label);
      }
      setMemberUserIds(ids);
      setNameByUserId(m);
      setIsOwnerMember(owner);
    } catch {
      /* ignore */
      setIsOwnerMember(false);
    }
  }, [token, userId]);

  const loadMessages = useCallback(async () => {
    if (!token || familyId == null) return;
    setLoading(true);
    setError(null);
    try {
      const res = await getFamilyChatMessages({
        family_id: familyId,
        limit: 80,
      });
      setItems(res.items ?? []);
      setReadStates(res.read_states ?? []);
      applyFamilyChatSeenFromMessages(familyId, res.items ?? []);
      void refreshUnread();
    } catch (e) {
      setError(e instanceof Error ? e.message : "読み込みに失敗しました");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [token, familyId, refreshUnread]);

  useEffect(() => {
    if (!open || !canUse) return;
    void loadMembers();
    void loadMessages();
  }, [open, canUse, loadMembers, loadMessages]);

  useEffect(() => {
    if (!open || !listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [open, items.length]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    if (!open) lastPostedReadRef.current = 0;
  }, [open]);

  const flushFamilyRead = useCallback(() => {
    if (familyId == null) return;
    const list = itemsRef.current;
    if (list.length === 0) return;
    const maxId = Math.max(...list.map((m) => m.id));
    if (maxId <= lastPostedReadRef.current) return;
    void (async () => {
      try {
        await postFamilyChatRead({ family_id: familyId, last_read_message_id: maxId });
        lastPostedReadRef.current = maxId;
      } catch {
        /* ignore */
      }
    })();
  }, [familyId]);

  useEffect(() => {
    if (!open || loading || items.length === 0) return;
    flushFamilyRead();
  }, [open, loading, items, flushFamilyRead]);

  const onListScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) flushFamilyRead();
  }, [flushFamilyRead]);

  const senderLabel = useCallback(
    (uid: number) => {
      if (userId != null && uid === userId) return "自分";
      return nameByUserId.get(uid) ?? `ユーザー${uid}`;
    },
    [nameByUserId, userId],
  );

  const onSend = useCallback(async () => {
    const text = draft.trim();
    if (!text || !token || familyId == null || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await postFamilyChatMessage({ body: text, family_id: familyId });
      setDraft("");
      if (res.message) {
        setItems((prev) => [...prev, res.message]);
        bumpFamilyChatSeenMaxMessageId(familyId, res.message.id);
        void refreshUnread();
        requestAnimationFrame(() => flushFamilyRead());
      } else {
        await loadMessages();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "送信に失敗しました");
    } finally {
      setSending(false);
    }
  }, [draft, token, familyId, sending, loadMessages, refreshUnread, flushFamilyRead]);

  const onSaveEdit = useCallback(async () => {
    if (editId == null || familyId == null) return;
    const text = editDraft.trim();
    if (!text) return;
    setEditBusy(true);
    setError(null);
    try {
      const res = await patchFamilyChatMessage(editId, { body: text });
      setItems((prev) => prev.map((x) => (x.id === editId ? res.message : x)));
      setEditId(null);
      setEditDraft("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "更新に失敗しました");
    } finally {
      setEditBusy(false);
    }
  }, [editId, editDraft, familyId]);

  const onDeleteMine = useCallback(
    async (m: SupportChatMessage) => {
      if (!window.confirm("このメッセージを削除しますか？")) return;
      setError(null);
      try {
        await deleteFamilyChatMessage(m.id);
        setItems((prev) => prev.filter((x) => x.id !== m.id));
        void refreshUnread();
      } catch (e) {
        setError(e instanceof Error ? e.message : "削除に失敗しました");
      }
    },
    [refreshUnread],
  );

  const bubbleClass = useMemo(
    () => ({
      mine: "ml-8 rounded-2xl rounded-br-md bg-emerald-600 text-white px-3 py-2 text-sm shadow-sm",
      other:
        "mr-8 rounded-2xl rounded-bl-md bg-slate-100 text-slate-800 px-3 py-2 text-sm shadow-sm border border-slate-200/80",
    }),
    [],
  );

  if (!canUse) return null;

  const isKid = variant === "kid";
  /** AI アドバイザー（右下）と重ならないよう、一般ユーザーは家族チャットを左下へ */
  const nudgeFab = Boolean(fabClearAiAdvisor && !isKid);
  const bottomSafe = "max(1rem, calc(0.75rem + env(safe-area-inset-bottom, 0px)))";

  return (
    <div
      className={
        nudgeFab
          ? "pointer-events-none fixed left-4 z-[1180] flex flex-col items-start gap-2"
          : `pointer-events-none fixed z-[60] flex flex-col items-end gap-2 ${
              isKid
                ? "bottom-[max(5.5rem,calc(1rem+env(safe-area-inset-bottom,0px)))] right-5"
                : "bottom-4 right-4"
            }`
      }
      style={nudgeFab ? { bottom: bottomSafe } : undefined}
    >
      {open ? (
        <div className="pointer-events-auto flex w-[min(92vw,340px)] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl">
          <div className="flex items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-800">{title}</p>
              <p className="text-[11px] text-slate-500">同じ家族のメンバーとやり取りできます</p>
            </div>
            <button
              type="button"
              className="rounded-full p-1.5 text-slate-500 hover:bg-slate-200/80 hover:text-slate-800"
              aria-label="閉じる"
              onClick={() => setOpen(false)}
            >
              <X size={18} />
            </button>
          </div>
          {error ? (
            <p className="px-3 py-2 text-xs text-rose-600">{error}</p>
          ) : null}
          <div
            ref={listRef}
            onScroll={onListScroll}
            className="max-h-[min(46vh,360px)] min-h-[180px] space-y-2 overflow-y-auto px-3 py-2"
          >
            {loading ? (
              <p className="text-center text-xs text-slate-500">読み込み中…</p>
            ) : items.length === 0 ? (
              <p className="text-center text-xs text-slate-500">
                メッセージはまだありません。最初の一言を送ってみましょう。
              </p>
            ) : (
              items.map((m) => {
                const mine = userId != null && m.sender_user_id === userId;
                const canManageMessage = mine || isOwnerMember;
                const readLabel =
                  userId != null
                    ? familyOutgoingReadLabel(m, userId, memberUserIds, readStates)
                    : null;
                return (
                  <div key={m.id} className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
                    <div className="mb-0.5 flex flex-wrap items-center gap-2 text-[10px] text-slate-400">
                      <span>{senderLabel(m.sender_user_id)}</span>
                      <span>{formatChatTime(m.created_at)}</span>
                      {m.edited_at ? <span>（編集済）</span> : null}
                      {readLabel ? (
                        <span className="font-semibold text-emerald-600">{readLabel}</span>
                      ) : null}
                      {canManageMessage ? (
                        <span className="flex gap-1">
                          <button
                            type="button"
                            className="rounded border border-slate-200 bg-white px-1 py-0.5 text-[10px] text-slate-600 hover:bg-slate-50"
                            onClick={() => {
                              setEditId(m.id);
                              setEditDraft(m.body);
                            }}
                          >
                            編集
                          </button>
                          <button
                            type="button"
                            className="rounded border border-slate-200 bg-white px-1 py-0.5 text-[10px] text-rose-600 hover:bg-rose-50"
                            onClick={() => void onDeleteMine(m)}
                          >
                            削除
                          </button>
                        </span>
                      ) : null}
                    </div>
                    <div className={mine ? bubbleClass.mine : bubbleClass.other}>{m.body}</div>
                  </div>
                );
              })
            )}
          </div>
          <div className="flex gap-2 border-t border-slate-100 p-2">
            <input
              className="min-w-0 flex-1 rounded-xl border border-slate-200 px-2.5 py-2 text-sm outline-none ring-emerald-500/30 focus:ring-2"
              placeholder="メッセージを入力…"
              value={draft}
              onChange={(ev) => setDraft(ev.target.value)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" && !ev.shiftKey) {
                  ev.preventDefault();
                  void onSend();
                }
              }}
              maxLength={8000}
            />
            <button
              type="button"
              disabled={sending || draft.trim().length === 0}
              className="inline-flex shrink-0 items-center justify-center rounded-xl bg-emerald-600 px-3 py-2 text-white shadow-sm hover:bg-emerald-700 disabled:opacity-40"
              aria-label="送信"
              onClick={() => void onSend()}
            >
              <Send size={18} />
            </button>
          </div>
        </div>
      ) : null}

      {open && editId != null ? (
        <div
          className="pointer-events-auto fixed inset-0 z-[1190] flex items-center justify-center bg-slate-900/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="メッセージを編集"
          onClick={(e) => {
            if (e.target === e.currentTarget && !editBusy) {
              setEditId(null);
              setEditDraft("");
            }
          }}
        >
          <div
            className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="mb-2 text-sm font-semibold text-slate-800">メッセージを編集</p>
            <textarea
              className="mb-3 min-h-[120px] w-full rounded-xl border border-slate-200 p-2 text-sm outline-none ring-emerald-500/30 focus:ring-2"
              value={editDraft}
              disabled={editBusy}
              onChange={(e) => setEditDraft(e.target.value)}
              maxLength={8000}
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
                disabled={editBusy}
                onClick={() => {
                  setEditId(null);
                  setEditDraft("");
                }}
              >
                キャンセル
              </button>
              <button
                type="button"
                className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-700 disabled:opacity-40"
                disabled={editBusy || !editDraft.trim()}
                onClick={() => void onSaveEdit()}
              >
                {editBusy ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <button
        type="button"
        className={
          isKid
            ? "pointer-events-auto relative inline-flex h-[4.75rem] w-[4.75rem] min-h-[4.75rem] min-w-[4.75rem] items-center justify-center rounded-full bg-gradient-to-br from-violet-200 via-fuchsia-100 to-amber-100 text-violet-950 shadow-[0_10px_28px_rgba(196,181,253,0.55)] ring-[3px] ring-white/95 ring-offset-2 ring-offset-violet-100/90 hover:from-violet-100 hover:via-fuchsia-50 hover:to-amber-50 active:scale-[0.97]"
            : "pointer-events-auto relative inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-600 text-white shadow-lg ring-2 ring-white hover:bg-emerald-700"
        }
        aria-label={title}
        onClick={() => setOpen((v) => !v)}
      >
        {isKid ? (
          <span className="relative inline-flex h-11 w-11 items-center justify-center" aria-hidden>
            <Rabbit className="h-9 w-9 drop-shadow-sm" strokeWidth={2.1} />
            <Mail
              className="absolute -bottom-0.5 -right-0.5 h-[1.35rem] w-[1.35rem] rounded-md bg-white/95 p-0.5 text-fuchsia-600 shadow-sm"
              strokeWidth={2.35}
            />
          </span>
        ) : (
          <MessageCircle size={22} />
        )}
        {unread && !open ? (
          <span
            className={
              isKid
                ? "absolute -right-0.5 -top-0.5 h-4 w-4 rounded-full bg-rose-500 ring-[3px] ring-white"
                : "absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full bg-rose-500 ring-2 ring-white"
            }
          />
        ) : null}
      </button>
    </div>
  );
}
