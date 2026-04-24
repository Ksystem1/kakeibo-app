import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { SupportChatThread } from "../components/SupportChatThread";
import { useAuth } from "../context/AuthContext";
import {
  deleteSupportChatMessage,
  getSupportChatMessages,
  patchSupportChatMessage,
  postSupportChatMessage,
  postSupportChatRead,
  type ChatReadState,
  type SupportChatMessage,
} from "../lib/api";
import { notifyAdminSupportQueueChanged } from "../hooks/useAdminSupportNeedsReplyBadge";
import { applySupportChatSeenFromMessages } from "../lib/supportChatSeen";
import { supportUserOutgoingReadLabel } from "../lib/chatReadReceipt";
import styles from "../components/KakeiboDashboard.module.css";

const PAGE_SIZE = 40;
const CHAT_POLL_MS_ACTIVE = 4000;
const CHAT_POLL_MS_IDLE = 9000;

export function SupportChatPage() {
  const { user } = useAuth();
  const scrollRef = useRef<HTMLDivElement>(null);
  const loadingOlderRef = useRef(false);

  const [items, setItems] = useState<SupportChatMessage[]>([]);
  const [readStates, setReadStates] = useState<ChatReadState[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextBeforeId, setNextBeforeId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [bodyEditId, setBodyEditId] = useState<number | null>(null);
  const [bodyEditDraft, setBodyEditDraft] = useState("");
  const [bodyEditBusy, setBodyEditBusy] = useState(false);
  const itemsRef = useRef<SupportChatMessage[]>([]);
  const lastPostedReadRef = useRef(0);

  const familyId =
    user?.familyId != null && Number.isFinite(Number(user.familyId))
      ? Number(user.familyId)
      : undefined;

  const selfUserId =
    user?.id != null && Number.isFinite(Number(user.id)) ? Number(user.id) : null;

  const loadInitial = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getSupportChatMessages({
        family_id: familyId,
        limit: PAGE_SIZE,
      });
      setItems(res.items);
      setReadStates(res.read_states ?? []);
      setHasMore(res.has_more);
      setNextBeforeId(res.next_before_id);
      applySupportChatSeenFromMessages(res.family_id, res.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "読み込みに失敗しました");
      setItems([]);
      setHasMore(false);
      setNextBeforeId(null);
    } finally {
      setLoading(false);
    }
  }, [familyId]);

  const refreshLatest = useCallback(async () => {
    if (loading || loadingOlder || sending) return;
    try {
      const el = scrollRef.current;
      const nearBottomBefore =
        el != null ? el.scrollHeight - el.scrollTop - el.clientHeight < 96 : true;
      const res = await getSupportChatMessages({
        family_id: familyId,
        limit: PAGE_SIZE,
      });
      const latest = Array.isArray(res.items) ? res.items : [];
      const prevMax = itemsRef.current.length > 0 ? Math.max(...itemsRef.current.map((m) => m.id)) : 0;
      const nextMax = latest.length > 0 ? Math.max(...latest.map((m) => m.id)) : 0;
      if (nextMax <= prevMax) return;
      setItems(latest);
      if (res.read_states) setReadStates(res.read_states);
      setHasMore(res.has_more);
      setNextBeforeId(res.next_before_id);
      applySupportChatSeenFromMessages(res.family_id, latest);
      if (nearBottomBefore) {
        requestAnimationFrame(() => {
          const box = scrollRef.current;
          if (box) box.scrollTop = box.scrollHeight;
        });
      }
    } catch {
      /* ポーリング失敗は無視（画面操作を妨げない） */
    }
  }, [familyId, loading, loadingOlder, sending]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  useEffect(() => {
    lastPostedReadRef.current = 0;
  }, [familyId]);

  useEffect(() => {
    if (loading || items.length === 0) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [loading, items.length]);

  const loadOlder = useCallback(async () => {
    if (!hasMore || nextBeforeId == null || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    setError(null);
    const el = scrollRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    try {
      const res = await getSupportChatMessages({
        family_id: familyId,
        limit: PAGE_SIZE,
        before: nextBeforeId,
      });
      const seen = new Set(items.map((x) => x.id));
      const merged = [...res.items.filter((x) => !seen.has(x.id)), ...items];
      setItems(merged);
      if (res.read_states) setReadStates(res.read_states);
      setHasMore(res.has_more);
      setNextBeforeId(res.next_before_id);
      applySupportChatSeenFromMessages(res.family_id, merged);
      requestAnimationFrame(() => {
        const box = scrollRef.current;
        if (box) box.scrollTop = box.scrollHeight - prevHeight;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "過去メッセージの取得に失敗しました");
    } finally {
      setLoadingOlder(false);
      loadingOlderRef.current = false;
    }
  }, [familyId, hasMore, nextBeforeId, items]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const flushReadReceipt = useCallback(() => {
    const list = itemsRef.current;
    if (list.length === 0) return;
    const maxId = Math.max(...list.map((m) => m.id));
    if (maxId <= lastPostedReadRef.current) return;
    void (async () => {
      try {
        await postSupportChatRead({
          ...(familyId != null ? { family_id: familyId } : {}),
          last_read_message_id: maxId,
        });
        lastPostedReadRef.current = maxId;
      } catch {
        /* ignore */
      }
    })();
  }, [familyId]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || loading || loadingOlder) return;
    if (el.scrollTop < 72 && hasMore && nextBeforeId != null) {
      void loadOlder();
      return;
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
    if (nearBottom) flushReadReceipt();
  }, [hasMore, nextBeforeId, loadOlder, loading, loadingOlder, flushReadReceipt]);

  useEffect(() => {
    if (loading || items.length === 0) return;
    flushReadReceipt();
  }, [loading, items, flushReadReceipt]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const loop = async () => {
      if (cancelled) return;
      const hidden = typeof document !== "undefined" && document.visibilityState !== "visible";
      const wait = hidden ? CHAT_POLL_MS_IDLE : CHAT_POLL_MS_ACTIVE;
      timer = setTimeout(async () => {
        await refreshLatest();
        await loop();
      }, wait);
    };
    void loop();
    const onFocus = () => {
      void refreshLatest();
    };
    if (typeof window !== "undefined") {
      window.addEventListener("focus", onFocus);
      window.addEventListener("online", onFocus);
    }
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", onFocus);
        window.removeEventListener("online", onFocus);
      }
    };
  }, [refreshLatest]);

  const onSend = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await postSupportChatMessage({
        body: text,
        ...(familyId != null ? { family_id: familyId } : {}),
      });
      setDraft("");
      setItems((prev) => {
        if (prev.some((x) => x.id === res.message.id)) return prev;
        const next = [...prev, res.message];
        applySupportChatSeenFromMessages(res.message.family_id, next);
        notifyAdminSupportQueueChanged();
        return next;
      });
      requestAnimationFrame(() => {
        const box = scrollRef.current;
        if (box) box.scrollTop = box.scrollHeight;
      });
      flushReadReceipt();
    } catch (e) {
      setError(e instanceof Error ? e.message : "送信に失敗しました");
    } finally {
      setSending(false);
    }
  }, [draft, sending, familyId, flushReadReceipt]);

  const onSaveBodyEdit = useCallback(async () => {
    if (bodyEditId == null) return;
    const text = bodyEditDraft.trim();
    if (!text) return;
    setBodyEditBusy(true);
    setError(null);
    try {
      const res = await patchSupportChatMessage(bodyEditId, { body: text });
      setItems((prev) => prev.map((x) => (x.id === bodyEditId ? res.message : x)));
      setBodyEditId(null);
      setBodyEditDraft("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "本文の更新に失敗しました");
    } finally {
      setBodyEditBusy(false);
    }
  }, [bodyEditId, bodyEditDraft]);

  const onDeleteOwn = useCallback(
    async (m: SupportChatMessage) => {
      if (!window.confirm("このメッセージを削除しますか？")) return;
      setError(null);
      try {
        await deleteSupportChatMessage(m.id);
        setItems((prev) => prev.filter((x) => x.id !== m.id));
        notifyAdminSupportQueueChanged();
      } catch (e) {
        setError(e instanceof Error ? e.message : "削除に失敗しました");
      }
    },
    [],
  );

  return (
    <div className={styles.wrap} style={{ maxWidth: 720, margin: "0 auto" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          flexWrap: "wrap",
          marginBottom: "0.65rem",
        }}
      >
        <Link to="/settings" className={styles.sub} style={{ textDecoration: "none" }}>
          ← 設定に戻る
        </Link>
      </div>
      <h1 className={styles.title} style={{ marginBottom: "0.35rem" }}>
        運営サポート
      </h1>
      <p className={styles.sub} style={{ marginBottom: "0.75rem", lineHeight: 1.55 }}>
        家族単位でお問い合わせいただけます。管理者からの返信は左側の吹き出しで表示されます。
      </p>
      {error ? (
        <p
          role="alert"
          style={{
            color: "#b91c1c",
            fontSize: "0.9rem",
            marginBottom: "0.5rem",
          }}
        >
          {error}
        </p>
      ) : null}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "min(72vh, 560px)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          background: "var(--bg-card)",
          overflow: "hidden",
        }}
      >
        <div
          ref={scrollRef}
          onScroll={onScroll}
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "0.5rem 0.65rem",
            background: "var(--bg)",
          }}
        >
          {loadingOlder ? (
            <p style={{ textAlign: "center", fontSize: "0.82rem", color: "var(--text-muted)" }}>
              さらに読み込み中…
            </p>
          ) : hasMore && nextBeforeId != null ? (
            <p style={{ textAlign: "center", fontSize: "0.78rem", color: "var(--text-muted)" }}>
              上にスクロールすると過去のメッセージを表示します
            </p>
          ) : null}
          {loading ? (
            <p style={{ textAlign: "center", color: "var(--text-muted)" }}>読み込み中…</p>
          ) : items.length === 0 ? (
            <p style={{ textAlign: "center", color: "var(--text-muted)" }}>
              まだメッセージがありません。下の欄から送信してください。
            </p>
          ) : (
            <SupportChatThread
              variant="user"
              items={items}
              readReceiptForMessage={(m) =>
                selfUserId != null ? supportUserOutgoingReadLabel(m, selfUserId, readStates) : null
              }
              messageActions={(m) => {
                if (
                  selfUserId == null ||
                  m.is_staff ||
                  m.sender_user_id !== selfUserId
                ) {
                  return null;
                }
                return (
                  <span style={{ marginLeft: "0.35rem" }}>
                    <button
                      type="button"
                      title="編集"
                      onClick={() => {
                        setBodyEditId(m.id);
                        setBodyEditDraft(m.body);
                      }}
                      style={{
                        font: "inherit",
                        fontSize: "0.72rem",
                        cursor: "pointer",
                        padding: "0.1rem 0.25rem",
                        borderRadius: 4,
                        border: "1px solid var(--border)",
                        background: "var(--bg-card)",
                      }}
                    >
                      編集
                    </button>{" "}
                    <button
                      type="button"
                      title="削除"
                      onClick={() => {
                        void onDeleteOwn(m);
                      }}
                      style={{
                        font: "inherit",
                        fontSize: "0.72rem",
                        cursor: "pointer",
                        padding: "0.1rem 0.25rem",
                        borderRadius: 4,
                        border: "1px solid var(--border)",
                        background: "var(--bg-card)",
                      }}
                    >
                      削除
                    </button>
                  </span>
                );
              }}
            />
          )}
        </div>
        <div
          style={{
            display: "flex",
            gap: "0.45rem",
            padding: "0.55rem 0.65rem",
            borderTop: "1px solid var(--border)",
            alignItems: "flex-end",
            background: "var(--bg-card)",
          }}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="メッセージを入力…"
            rows={2}
            disabled={sending || loading}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void onSend();
              }
            }}
            style={{
              flex: 1,
              resize: "none",
              font: "inherit",
              fontSize: "0.92rem",
              padding: "0.45rem 0.55rem",
              borderRadius: 10,
              border: "1px solid var(--border)",
              background: "var(--input-bg)",
              color: "var(--text)",
            }}
          />
          <button
            type="button"
            className={styles.btn}
            disabled={sending || loading || !draft.trim()}
            onClick={() => {
              void onSend();
            }}
          >
            {sending ? "送信中" : "送信"}
          </button>
        </div>
      </div>

      {bodyEditId != null ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="user-support-body-edit-title"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 43, 71, 0.45)",
            zIndex: 10000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1rem",
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget && !bodyEditBusy) {
              setBodyEditId(null);
              setBodyEditDraft("");
            }
          }}
        >
          <div
            onClick={(ev) => {
              ev.stopPropagation();
            }}
            style={{
              width: "100%",
              maxWidth: 440,
              padding: "1rem",
              borderRadius: 14,
              border: "1px solid var(--border)",
              background: "var(--bg-card)",
              boxShadow: "0 12px 40px rgba(0, 0, 0, 0.22)",
            }}
          >
            <h2 id="user-support-body-edit-title" style={{ margin: "0 0 0.65rem", fontSize: "1.05rem" }}>
              メッセージを編集
            </h2>
            <textarea
              value={bodyEditDraft}
              onChange={(e) => setBodyEditDraft(e.target.value)}
              rows={8}
              disabled={bodyEditBusy}
              style={{
                width: "100%",
                boxSizing: "border-box",
                font: "inherit",
                fontSize: "0.92rem",
                padding: "0.5rem 0.55rem",
                borderRadius: 10,
                border: "1px solid var(--border)",
                background: "var(--input-bg)",
                color: "var(--text)",
                resize: "vertical",
              }}
            />
            <div
              style={{
                marginTop: "0.75rem",
                display: "flex",
                gap: "0.5rem",
                justifyContent: "flex-end",
                flexWrap: "wrap",
              }}
            >
              <button
                type="button"
                disabled={bodyEditBusy}
                onClick={() => {
                  setBodyEditId(null);
                  setBodyEditDraft("");
                }}
                style={{
                  font: "inherit",
                  padding: "0.4rem 0.75rem",
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  cursor: "pointer",
                  background: "transparent",
                }}
              >
                キャンセル
              </button>
              <button
                type="button"
                disabled={bodyEditBusy || !bodyEditDraft.trim()}
                onClick={() => {
                  void onSaveBodyEdit();
                }}
                style={{
                  font: "inherit",
                  padding: "0.4rem 0.85rem",
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  cursor: "pointer",
                  background: "var(--accent-dim)",
                }}
              >
                {bodyEditBusy ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
