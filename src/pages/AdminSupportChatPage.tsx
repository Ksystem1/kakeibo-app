import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { SupportChatThread } from "../components/SupportChatThread";
import {
  deleteAdminSupportChatMessage,
  getAdminSupportChatFamilies,
  getAdminSupportChatMessages,
  patchAdminSupportChatMessage,
  postAdminSupportChatMessage,
  postAdminSupportChatRead,
  type AdminSupportChatFamilyRow,
  type ChatReadState,
  type SupportChatMessage,
} from "../lib/api";
import { supportStaffOutgoingReadLabel } from "../lib/chatReadReceipt";
import {
  familyNeedsAdminReply,
  notifyAdminSupportQueueChanged,
} from "../hooks/useAdminSupportNeedsReplyBadge";

const PAGE_SIZE = 40;

function formatMemberLoginLine(m: {
  display_name: string | null;
  login_name: string | null;
  email: string;
}): string {
  const name = (m.display_name ?? "").trim() || "（表示名なし）";
  const login = (m.login_name ?? "").trim();
  if (login) return `${name} — ログイン: ${login}`;
  const em = (m.email ?? "").trim();
  if (em) return `${name} — ログイン: （未設定） / ${em}`;
  return `${name} — ログイン: （未設定）`;
}

function formatListTime(iso: string | null | undefined): string {
  if (iso == null || iso === "") return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export function AdminSupportChatPage() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const loadingOlderRef = useRef(false);

  const [families, setFamilies] = useState<AdminSupportChatFamilyRow[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [selectedFamilyId, setSelectedFamilyId] = useState<number | null>(null);
  const [items, setItems] = useState<SupportChatMessage[]>([]);
  const [readStates, setReadStates] = useState<ChatReadState[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextBeforeId, setNextBeforeId] = useState<number | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [sending, setSending] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [markImportant, setMarkImportant] = useState(false);
  const [bodyEditId, setBodyEditId] = useState<number | null>(null);
  const [bodyEditDraft, setBodyEditDraft] = useState("");
  const [bodyEditBusy, setBodyEditBusy] = useState(false);
  const itemsRef = useRef<SupportChatMessage[]>([]);
  const lastPostedReadRef = useRef(0);

  const memberUserIds = useMemo(() => {
    if (selectedFamilyId == null) return [];
    const f = families.find((x) => x.family_id === selectedFamilyId);
    const mem = Array.isArray(f?.members) ? f.members : [];
    return mem
      .map((m) => Number(m.user_id))
      .filter((id) => Number.isFinite(id));
  }, [families, selectedFamilyId]);

  const loadFamilies = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      const res = await getAdminSupportChatFamilies();
      setFamilies(Array.isArray(res.items) ? res.items : []);
    } catch (e) {
      setListError(e instanceof Error ? e.message : "一覧の取得に失敗しました");
      setFamilies([]);
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadFamilies();
  }, [loadFamilies]);

  const loadThreadInitial = useCallback(async (familyId: number) => {
    setThreadLoading(true);
    setThreadError(null);
    setItems([]);
    setHasMore(false);
    setNextBeforeId(null);
    try {
      const res = await getAdminSupportChatMessages({
        family_id: familyId,
        limit: PAGE_SIZE,
      });
      setItems(res.items);
      setReadStates(res.read_states ?? []);
      setHasMore(res.has_more);
      setNextBeforeId(res.next_before_id);
    } catch (e) {
      setThreadError(e instanceof Error ? e.message : "メッセージの取得に失敗しました");
    } finally {
      setThreadLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedFamilyId == null) return;
    void loadThreadInitial(selectedFamilyId);
  }, [selectedFamilyId, loadThreadInitial]);

  useEffect(() => {
    setBodyEditId(null);
    setBodyEditDraft("");
  }, [selectedFamilyId]);

  useEffect(() => {
    lastPostedReadRef.current = 0;
  }, [selectedFamilyId]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const flushAdminSupportRead = useCallback(() => {
    if (selectedFamilyId == null) return;
    const list = itemsRef.current;
    if (list.length === 0) return;
    const maxId = Math.max(...list.map((m) => m.id));
    if (maxId <= lastPostedReadRef.current) return;
    void (async () => {
      try {
        await postAdminSupportChatRead({
          family_id: selectedFamilyId,
          last_read_message_id: maxId,
        });
        lastPostedReadRef.current = maxId;
      } catch {
        /* ignore */
      }
    })();
  }, [selectedFamilyId]);

  useEffect(() => {
    if (threadLoading || items.length === 0 || selectedFamilyId == null) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [threadLoading, items.length, selectedFamilyId]);

  const loadOlder = useCallback(async () => {
    if (selectedFamilyId == null || !hasMore || nextBeforeId == null || loadingOlderRef.current) {
      return;
    }
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    setThreadError(null);
    const el = scrollRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    try {
      const res = await getAdminSupportChatMessages({
        family_id: selectedFamilyId,
        limit: PAGE_SIZE,
        before: nextBeforeId,
      });
      const seen = new Set(items.map((x) => x.id));
      const merged = [...res.items.filter((x) => !seen.has(x.id)), ...items];
      setItems(merged);
      if (res.read_states) setReadStates(res.read_states);
      setHasMore(res.has_more);
      setNextBeforeId(res.next_before_id);
      requestAnimationFrame(() => {
        const box = scrollRef.current;
        if (box) box.scrollTop = box.scrollHeight - prevHeight;
      });
    } catch (e) {
      setThreadError(e instanceof Error ? e.message : "過去メッセージの取得に失敗しました");
    } finally {
      setLoadingOlder(false);
      loadingOlderRef.current = false;
    }
  }, [selectedFamilyId, hasMore, nextBeforeId, items]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || threadLoading || loadingOlder) return;
    if (el.scrollTop < 72 && hasMore && nextBeforeId != null) {
      void loadOlder();
      return;
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
    if (nearBottom) flushAdminSupportRead();
  }, [hasMore, nextBeforeId, loadOlder, threadLoading, loadingOlder, flushAdminSupportRead]);

  useEffect(() => {
    if (threadLoading || items.length === 0 || selectedFamilyId == null) return;
    flushAdminSupportRead();
  }, [threadLoading, items.length, selectedFamilyId, flushAdminSupportRead]);

  const onSend = useCallback(async () => {
    if (selectedFamilyId == null) return;
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setThreadError(null);
    try {
      const res = await postAdminSupportChatMessage({
        family_id: selectedFamilyId,
        body: text,
        is_important: markImportant,
      });
      setDraft("");
      setMarkImportant(false);
      setItems((prev) => {
        if (prev.some((x) => x.id === res.message.id)) return prev;
        return [...prev, res.message];
      });
      void loadFamilies();
      notifyAdminSupportQueueChanged();
      requestAnimationFrame(() => {
        const box = scrollRef.current;
        if (box) box.scrollTop = box.scrollHeight;
      });
      flushAdminSupportRead();
    } catch (e) {
      setThreadError(e instanceof Error ? e.message : "送信に失敗しました");
    } finally {
      setSending(false);
    }
  }, [draft, sending, selectedFamilyId, markImportant, loadFamilies, flushAdminSupportRead]);

  const onDelete = useCallback(
    async (m: SupportChatMessage) => {
      if (!window.confirm("このメッセージを削除しますか？（ユーザー側からも消えます）")) return;
      setThreadError(null);
      try {
        await deleteAdminSupportChatMessage(m.id);
        setItems((prev) => prev.filter((x) => x.id !== m.id));
        void loadFamilies();
        notifyAdminSupportQueueChanged();
      } catch (e) {
        setThreadError(e instanceof Error ? e.message : "削除に失敗しました");
      }
    },
    [loadFamilies],
  );

  const onToggleImportant = useCallback(
    async (m: SupportChatMessage) => {
      setThreadError(null);
      try {
        const res = await patchAdminSupportChatMessage(m.id, {
          is_important: !m.is_important,
        });
        setItems((prev) => prev.map((x) => (x.id === m.id ? res.message : x)));
        void loadFamilies();
        notifyAdminSupportQueueChanged();
      } catch (e) {
        setThreadError(e instanceof Error ? e.message : "更新に失敗しました");
      }
    },
    [loadFamilies],
  );

  const onSaveBodyEdit = useCallback(async () => {
    if (bodyEditId == null) return;
    const text = bodyEditDraft.trim();
    if (!text) return;
    setBodyEditBusy(true);
    setThreadError(null);
    try {
      const res = await patchAdminSupportChatMessage(bodyEditId, { body: text });
      setItems((prev) => prev.map((x) => (x.id === bodyEditId ? res.message : x)));
      setBodyEditId(null);
      setBodyEditDraft("");
      void loadFamilies();
      notifyAdminSupportQueueChanged();
    } catch (e) {
      setThreadError(e instanceof Error ? e.message : "本文の更新に失敗しました");
    } finally {
      setBodyEditBusy(false);
    }
  }, [bodyEditId, bodyEditDraft, loadFamilies]);

  const selectedName =
    selectedFamilyId == null
      ? ""
      : families.find((f) => f.family_id === selectedFamilyId)?.family_name ?? "";

  return (
    <section style={{ padding: "1rem", maxWidth: 1200, margin: "0 auto" }}>
      <div style={{ marginBottom: "0.65rem" }}>
        <Link to="/admin" style={{ color: "var(--text-muted)", fontSize: "0.9rem" }}>
          ← 管理者ダッシュボード
        </Link>
      </div>
      <h1 style={{ margin: "0 0 0.35rem" }}>サポートチャット</h1>
      <p style={{ color: "var(--text-muted)", marginBottom: "1rem", lineHeight: 1.5 }}>
        家族ごとの最新メッセージを一覧し、個別に返信・削除・重要フラグの切り替え・管理者メッセージの本文編集ができます。
      </p>

      {listError ? (
        <p style={{ color: "#b91c1c", marginBottom: "0.75rem" }} role="alert">
          {listError}
        </p>
      ) : null}

      <div
        className="admin-support-chat-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(280px, 400px) 1fr",
          gap: "1rem",
          alignItems: "stretch",
        }}
      >
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: 12,
            background: "var(--bg-card)",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            maxHeight: "min(78vh, 640px)",
          }}
        >
          <div
            style={{
              padding: "0.55rem 0.7rem",
              borderBottom: "1px solid var(--border)",
              fontWeight: 700,
              fontSize: "0.92rem",
            }}
          >
            家族一覧
          </div>
          <div style={{ overflowY: "auto", flex: 1 }}>
            {listLoading ? (
              <p style={{ padding: "0.75rem", color: "var(--text-muted)" }}>読み込み中…</p>
            ) : families.length === 0 ? (
              <p style={{ padding: "0.75rem", color: "var(--text-muted)" }}>家族がありません</p>
            ) : (
              families.map((f) => {
                const needs = familyNeedsAdminReply(f);
                return (
                <button
                  key={f.family_id}
                  type="button"
                  onClick={() => setSelectedFamilyId(f.family_id)}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "0.65rem 0.75rem",
                    border: "none",
                    borderBottom: "1px solid var(--border)",
                    borderLeft: needs ? "4px solid #ea580c" : "4px solid transparent",
                    background:
                      selectedFamilyId === f.family_id ? "var(--accent-dim)" : "transparent",
                    cursor: "pointer",
                    font: "inherit",
                    color: "var(--text)",
                  }}
                >
                  <div
                    style={{
                      fontSize: "0.72rem",
                      fontWeight: 700,
                      color: "var(--text-muted)",
                      marginBottom: "0.15rem",
                    }}
                  >
                    家族ID: {f.family_id}
                  </div>
                  <div style={{ fontWeight: 600, marginBottom: "0.25rem" }}>
                    {needs ? <span title="要返信">🔔 </span> : null}
                    {f.family_name}
                  </div>
                  {(Array.isArray(f.members) ? f.members : []).length > 0 ? (
                    <div
                      style={{
                        fontSize: "0.76rem",
                        color: "var(--text-muted)",
                        lineHeight: 1.45,
                        marginBottom: "0.25rem",
                      }}
                    >
                      <div style={{ fontWeight: 600, marginBottom: "0.08rem" }}>メンバー</div>
                      {(Array.isArray(f.members) ? f.members : []).map((m) => (
                        <div key={m.user_id}>{formatMemberLoginLine(m)}</div>
                      ))}
                    </div>
                  ) : null}
                  {f.last_message ? (
                    <>
                      <div
                        style={{
                          fontSize: "0.82rem",
                          color: "var(--text-muted)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {f.last_message.is_important ? "★ " : ""}
                        {f.last_message.body}
                      </div>
                      <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: "0.15rem" }}>
                        {formatListTime(f.last_message.created_at)}
                      </div>
                    </>
                  ) : (
                    <div style={{ fontSize: "0.82rem", color: "var(--text-muted)" }}>（まだメッセージなし）</div>
                  )}
                </button>
                );
              })
            )}
          </div>
        </div>

        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: 12,
            background: "var(--bg-card)",
            display: "flex",
            flexDirection: "column",
            minHeight: "min(78vh, 640px)",
            overflow: "hidden",
          }}
        >
          {selectedFamilyId == null ? (
            <p style={{ padding: "1rem", color: "var(--text-muted)" }}>左の一覧から家族を選んでください</p>
          ) : (
            <>
              <div
                style={{
                  padding: "0.55rem 0.75rem",
                  borderBottom: "1px solid var(--border)",
                  fontWeight: 700,
                }}
              >
                {selectedName}{" "}
                <span style={{ fontWeight: 400, color: "var(--text-muted)", fontSize: "0.85rem" }}>
                  (ID {selectedFamilyId})
                </span>
              </div>
              {threadError ? (
                <p style={{ color: "#b91c1c", padding: "0 0.75rem", fontSize: "0.88rem" }} role="alert">
                  {threadError}
                </p>
              ) : null}
              <div
                ref={scrollRef}
                onScroll={onScroll}
                style={{
                  flex: 1,
                  overflowY: "auto",
                  padding: "0.5rem 0.65rem",
                  background: "var(--bg)",
                  minHeight: 0,
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
                {threadLoading ? (
                  <p style={{ textAlign: "center", color: "var(--text-muted)" }}>読み込み中…</p>
                ) : items.length === 0 ? (
                  <p style={{ textAlign: "center", color: "var(--text-muted)" }}>
                    まだメッセージがありません
                  </p>
                ) : (
                  <SupportChatThread
                    variant="admin"
                    items={items}
                    readReceiptForMessage={(m) =>
                      supportStaffOutgoingReadLabel(m, memberUserIds, readStates)
                    }
                    messageActions={(m) => (
                      <span style={{ marginLeft: "0.35rem" }}>
                        {m.is_staff ? (
                          <>
                            <button
                              type="button"
                              title="本文を編集"
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
                          </>
                        ) : null}
                        <button
                          type="button"
                          title="重要フラグ"
                          onClick={() => {
                            void onToggleImportant(m);
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
                          {m.is_important ? "★外す" : "★重要"}
                        </button>{" "}
                        <button
                          type="button"
                          title="削除"
                          onClick={() => {
                            void onDelete(m);
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
                    )}
                  />
                )}
              </div>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.35rem",
                  padding: "0.55rem 0.65rem",
                  borderTop: "1px solid var(--border)",
                  background: "var(--bg-card)",
                }}
              >
                <label
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.35rem",
                    fontSize: "0.85rem",
                    color: "var(--text-muted)",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={markImportant}
                    disabled={sending || threadLoading}
                    onChange={(e) => setMarkImportant(e.target.checked)}
                  />
                  この送信を「重要（メモ）」にする
                </label>
                <div style={{ display: "flex", gap: "0.45rem", alignItems: "flex-end" }}>
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="返信を入力…"
                    rows={2}
                    disabled={sending || threadLoading}
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
                    disabled={sending || threadLoading || !draft.trim()}
                    onClick={() => {
                      void onSend();
                    }}
                    style={{
                      font: "inherit",
                      padding: "0.45rem 0.85rem",
                      borderRadius: 10,
                      border: "1px solid var(--border)",
                      cursor: "pointer",
                      background: "var(--accent-dim)",
                    }}
                  >
                    {sending ? "送信中" : "送信"}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <style>{`
        @media (max-width: 820px) {
          .admin-support-chat-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>

      {bodyEditId != null ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="support-body-edit-title"
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
            <h2 id="support-body-edit-title" style={{ margin: "0 0 0.65rem", fontSize: "1.05rem" }}>
              管理者メッセージを編集
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
    </section>
  );
}
