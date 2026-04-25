import { MessageCircle, PiggyBank, Send, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import {
  askAiAdvisor,
  getMonthSummary,
  ledgerKidWatchApiOptionsFromSearch,
  normalizeFamilyRole,
} from "../lib/api";

type ChatMessage = {
  id: number;
  role: "user" | "ai";
  text: string;
  typing?: boolean;
};

function currentYm() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** 家計簿の ?month= と同じルール（ダッシュボード表示月とAIの集計月を一致させる） */
function parseMonthParam(search: string): string | null {
  const p = new URLSearchParams(search).get("month");
  return p && /^\d{4}-\d{2}$/.test(p) ? p : null;
}

function advisorYearMonth(search: string) {
  return parseMonthParam(search) ?? currentYm();
}

function buildClientFallback(
  question: string,
  summary: {
    incomeTotal: number;
    expenseTotal: number;
    fixedCostFromSettings?: number;
    netMonthlyBalance?: number;
    topCategoryName: string;
    topCategoryTotal: number;
  },
) {
  const q = String(question ?? "");
  const lower = q.toLowerCase();
  const fixed = Number(summary.fixedCostFromSettings ?? 0);
  const fixedInNet =
    summary.incomeTotal > 0 || summary.expenseTotal > 0 ? fixed : 0;
  const rest =
    summary.netMonthlyBalance != null && Number.isFinite(summary.netMonthlyBalance)
      ? Math.round(summary.netMonthlyBalance)
      : Math.max(0, Math.round(summary.incomeTotal - summary.expenseTotal - fixedInNet));
  if (q.includes("解析") || q.includes("読み取り") || q.includes("読取")) {
    return "レシート画面の「おまかせ取込」から画像を選ぶと、合計・日付・カテゴリ候補が自動入力されます。内容を確認して「登録」を押すと保存できます。";
  }
  if (q.includes("登録方法") || q.includes("登録") || lower.includes("how to register")) {
    return "家計簿の「取引を追加」で種別・カテゴリ・日付・金額を入力して「追加」を押すと登録できます。おまかせ取込でも同様に最後は「登録」を押せば保存されます。";
  }
  if (q.includes("使い方")) {
    return `「食費を月5,000円下げたい」のように数値つきで聞くと、より具体的に提案できます。今月は${summary.topCategoryName}が${summary.topCategoryTotal.toLocaleString("ja-JP")}円なので、まずここから見直しましょう。`;
  }
  if (q.includes("カテゴリ")) {
    return `カテゴリ別では、まず${summary.topCategoryName}が見直し候補です。上限を先に決めて、週ごとに配分すると管理しやすくなります。`;
  }
  if (q.includes("食費")) {
    return "食費は週予算を先に決めるとブレにくくなります。買い物前に上限を決め、余った分は翌週へ繰り越す運用がおすすめです。";
  }
  return `今月の残り予算は${rest.toLocaleString("ja-JP")}円です。まずは${summary.topCategoryName}の上限設定から始めると効果が出やすいです。`;
}

export function AiAdvisorChat() {
  const location = useLocation();
  const { user } = useAuth();
  const summaryYm = useMemo(() => advisorYearMonth(location.search), [location.search]);
  const monthSummaryOpts = useMemo(() => {
    const role = normalizeFamilyRole(user?.familyRole);
    const parent = role === "ADMIN" || role === "MEMBER";
    const kidOpts =
      parent && location.pathname === "/"
        ? ledgerKidWatchApiOptionsFromSearch(location.search)
        : undefined;
    return {
      scope: "family" as const,
      ...(kidOpts ?? {}),
    };
  }, [location.pathname, location.search, user?.familyRole]);
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: 1, role: "ai", text: "こんにちは。AI家計アドバイザーです。気軽に相談してください。" },
  ]);

  const canSend = input.trim().length > 0 && !busy;

  function scrollToBottom() {
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
  }

  function renderRichAiText(text: string) {
    const parts = text.split(/(節約額[:：]?\s*¥[\d,]+|¥[\d,]+)/g).filter(Boolean);
    return parts.map((p, i) => {
      const strong = /(節約額[:：]?\s*¥[\d,]+|¥[\d,]+)/.test(p);
      return (
        <span key={`${p}-${i}`} className={strong ? "font-bold text-emerald-600" : ""}>
          {p}
        </span>
      );
    });
  }

  async function sendMessage(rawText: string) {
    const text = rawText.trim();
    if (!text || busy) return;
    const userMsg: ChatMessage = {
      id: Date.now(),
      role: "user",
      text,
    };
    const typingId = Date.now() + 1;
    setMessages((prev) => [...prev, userMsg, { id: typingId, role: "ai", text: "", typing: true }]);
    scrollToBottom();
    setBusy(true);
    try {
      const ym = summaryYm;
      const sum = await getMonthSummary(ym, monthSummaryOpts);
      const summaryLite = {
        incomeTotal: Number(sum.incomeTotal ?? 0),
        expenseTotal: Number(sum.expenseTotal ?? 0),
        fixedCostFromSettings: Number(sum.fixedCostFromSettings ?? 0),
        netMonthlyBalance:
          sum.netMonthlyBalance != null && sum.netMonthlyBalance !== ""
            ? Number(sum.netMonthlyBalance)
            : undefined,
        topCategoryName: sum.expensesByCategory?.[0]?.category_name ?? "変動費",
        topCategoryTotal: Number(sum.expensesByCategory?.[0]?.total ?? 0),
      };
      const historySeed: ChatMessage[] = [
        ...messages,
        { id: -1, role: "user", text },
      ];
      const history = historySeed
        .filter((m) => !m.typing && String(m.text ?? "").trim())
        .slice(-8)
        .map((m) => ({
          role: m.role,
          text: String(m.text).trim().slice(0, 240),
        }));
      const reply = await askAiAdvisor({
        message: text,
        context: {
          yearMonth: ym,
          incomeTotal: summaryLite.incomeTotal,
          expenseTotal: summaryLite.expenseTotal,
          fixedCostFromSettings: summaryLite.fixedCostFromSettings,
          netMonthlyBalance: summaryLite.netMonthlyBalance,
          topCategories: (sum.expensesByCategory ?? []).slice(0, 10).map((x) => ({
            name: x.category_name ?? "未分類",
            total: Number(x.total ?? 0),
          })),
          history,
        },
      });
      const normalizedReply = String(reply.reply ?? "").trim();
      const finalReply = normalizedReply || buildClientFallback(text, summaryLite);
      setMessages((prev) =>
        prev.map((m) => (m.id === typingId ? { id: typingId, role: "ai", text: finalReply } : m)),
      );
      scrollToBottom();
    } catch {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === typingId
            ? {
                id: typingId,
                role: "ai",
                text: "通信状況の影響で詳細分析ができませんでした。固定費の見直し（通信費・サブスク）から始めるのがおすすめです。",
              }
            : m,
        ),
      );
      scrollToBottom();
    } finally {
      setBusy(false);
    }
  }

  async function onSend() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    await sendMessage(text);
  }

  const bubbles = useMemo(
    () =>
      messages.map((m) => (
        <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
          <div
            className={
              m.role === "user"
                ? "max-w-[82%] rounded-2xl rounded-br-md bg-blue-500 px-3 py-2 text-sm text-white shadow-sm"
                : "max-w-[82%] rounded-2xl rounded-bl-md bg-slate-100 px-3 py-2 text-sm text-slate-800 shadow-sm"
            }
          >
            {m.typing ? (
              <span className="inline-flex items-center gap-1 text-slate-600">
                AIが考えています
                <span className="inline-flex">
                  <span className="animate-bounce [animation-delay:0ms]">.</span>
                  <span className="animate-bounce [animation-delay:120ms]">.</span>
                  <span className="animate-bounce [animation-delay:240ms]">.</span>
                </span>
              </span>
            ) : m.role === "ai" ? (
              <span>{renderRichAiText(m.text)}</span>
            ) : (
              <span>{m.text}</span>
            )}
          </div>
        </div>
      )),
    [messages],
  );

  return (
    <>
      {open ? (
        <section className="fixed right-3 z-[1100] flex h-[62vh] w-[min(90vw,360px)] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 shadow-2xl md:right-4 md:h-[74vh] md:w-[min(96vw,420px)]"
          style={{ bottom: "max(5.5rem, calc(env(safe-area-inset-bottom) + 5rem))" }}>
          <header className="flex items-center justify-between border-b border-slate-200 bg-white px-3 py-2">
            <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-800">
              AI家計アドバイザー 🐷
            </h2>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="shrink-0 rounded-md p-1 text-slate-500 hover:bg-slate-200"
              aria-label="閉じる"
            >
              <X size={16} />
            </button>
          </header>

          <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto bg-slate-100 p-3">
            {bubbles}
          </div>

          <div className="border-t border-slate-200 bg-white p-2">
            <div className="flex items-center gap-2">
              <input
                className="h-10 flex-1 rounded-full border border-slate-300 px-3 text-base outline-none focus:border-emerald-400 md:text-sm"
                placeholder="家計の相談を入力..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void onSend();
                }}
                disabled={busy}
              />
              <button
                type="button"
                onClick={() => void onSend()}
                disabled={!canSend}
                className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-500 text-white disabled:opacity-50"
              >
                <Send size={16} />
              </button>
            </div>
          </div>
        </section>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="fixed right-4 z-[1200] flex h-14 w-14 items-center justify-center rounded-full bg-blue-500 text-white shadow-xl shadow-blue-500/30"
        style={{ bottom: "max(1rem, calc(env(safe-area-inset-bottom) + 0.75rem))" }}
        aria-label="AIアドバイザーチャットを開く"
      >
        <span className="relative">
          <MessageCircle size={22} />
          <PiggyBank size={12} className="absolute -bottom-2 -right-2 rounded-full bg-white p-0.5 text-emerald-600" />
        </span>
      </button>
    </>
  );
}
