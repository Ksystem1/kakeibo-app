import { Mail, MessageCircle, Rabbit, Send, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";
import {
  getFamilyChatMessages,
  getFamilyMembers,
  postFamilyChatMessage,
  type SupportChatMessage,
} from "../lib/api";
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

export function FamilyChatDock({ title = "家族チャット", variant = "default" }: Props) {
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
  const listRef = useRef<HTMLDivElement | null>(null);

  const canUse = Boolean(token && familyId && userId != null);

  const loadMembers = useCallback(async () => {
    if (!token) return;
    try {
      const res = await getFamilyMembers();
      const m = new Map<number, string>();
      for (const it of res.items ?? []) {
        const id = Number(it.id);
        if (!Number.isFinite(id)) continue;
        const label =
          it.display_name != null && String(it.display_name).trim() !== ""
            ? String(it.display_name).trim()
            : it.email
              ? String(it.email).split("@")[0]
              : `ユーザー${id}`;
        m.set(id, label);
      }
      setNameByUserId(m);
    } catch {
      /* ignore */
    }
  }, [token]);

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
      } else {
        await loadMessages();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "送信に失敗しました");
    } finally {
      setSending(false);
    }
  }, [draft, token, familyId, sending, loadMessages, refreshUnread]);

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

  return (
    <div
      className={`pointer-events-none fixed z-[60] flex flex-col items-end gap-2 ${
        isKid ? "bottom-5 right-5" : "bottom-4 right-4"
      }`}
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
                return (
                  <div key={m.id} className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
                    <div className="mb-0.5 flex items-center gap-2 text-[10px] text-slate-400">
                      <span>{senderLabel(m.sender_user_id)}</span>
                      <span>{formatChatTime(m.created_at)}</span>
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
