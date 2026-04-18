import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { SupportChatThread } from "../components/SupportChatThread";
import { useAuth } from "../context/AuthContext";
import {
  getSupportChatMessages,
  postSupportChatMessage,
  type SupportChatMessage,
} from "../lib/api";
import { notifyAdminSupportQueueChanged } from "../hooks/useAdminSupportNeedsReplyBadge";
import { applySupportChatSeenFromMessages } from "../lib/supportChatSeen";
import styles from "../components/KakeiboDashboard.module.css";

const PAGE_SIZE = 40;

export function SupportChatPage() {
  const { user } = useAuth();
  const scrollRef = useRef<HTMLDivElement>(null);
  const loadingOlderRef = useRef(false);

  const [items, setItems] = useState<SupportChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextBeforeId, setNextBeforeId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const familyId =
    user?.familyId != null && Number.isFinite(Number(user.familyId))
      ? Number(user.familyId)
      : undefined;

  const loadInitial = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getSupportChatMessages({
        family_id: familyId,
        limit: PAGE_SIZE,
      });
      setItems(res.items);
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

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

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

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || loading || loadingOlder) return;
    if (el.scrollTop < 72 && hasMore && nextBeforeId != null) {
      void loadOlder();
    }
  }, [hasMore, nextBeforeId, loadOlder, loading, loadingOlder]);

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
    } catch (e) {
      setError(e instanceof Error ? e.message : "送信に失敗しました");
    } finally {
      setSending(false);
    }
  }, [draft, sending, familyId]);

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
            <SupportChatThread variant="user" items={items} />
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
    </div>
  );
}
