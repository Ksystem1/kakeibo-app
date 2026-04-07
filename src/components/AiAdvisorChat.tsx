import { MessageCircle, Send, Sparkles, X } from "lucide-react";
import { useMemo, useState } from "react";
import { askAiAdvisor, getMonthSummary } from "../lib/api";

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

export function AiAdvisorChat() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: 1, role: "ai", text: "こんにちは。AI家計アドバイザーです。気軽に相談してください。" },
  ]);

  const canSend = input.trim().length > 0 && !busy;

  async function runDemoMode() {
    if (busy) return;
    setOpen(true);
    const prompt = "今月あといくら使える？";
    const userMsg: ChatMessage = { id: Date.now(), role: "user", text: prompt };
    const typingId = Date.now() + 1;
    setMessages((prev) => [...prev, userMsg, { id: typingId, role: "ai", text: "", typing: true }]);
    setBusy(true);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    setMessages((prev) =>
      prev.map((m) =>
        m.id === typingId
          ? {
              id: typingId,
              role: "ai",
              text: "今月の残り予算は24,500円です。このペースだと月末に5,000円余る計算ですよ！",
            }
          : m,
      ),
    );
    setBusy(false);
  }

  async function onSend() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    const userMsg: ChatMessage = { id: Date.now(), role: "user", text };
    const typingId = Date.now() + 1;
    setMessages((prev) => [...prev, userMsg, { id: typingId, role: "ai", text: "", typing: true }]);
    setBusy(true);
    try {
      const ym = currentYm();
      const sum = await getMonthSummary(ym, { scope: "family" });
      const reply = await askAiAdvisor({
        message: text,
        context: {
          yearMonth: ym,
          incomeTotal: Number(sum.incomeTotal ?? 0),
          expenseTotal: Number(sum.expenseTotal ?? 0),
          topCategories: (sum.expensesByCategory ?? []).slice(0, 3).map((x) => ({
            name: x.category_name ?? "未分類",
            total: Number(x.total ?? 0),
          })),
        },
      });
      setMessages((prev) =>
        prev.map((m) => (m.id === typingId ? { id: typingId, role: "ai", text: reply.reply } : m)),
      );
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
    } finally {
      setBusy(false);
    }
  }

  const bubbles = useMemo(
    () =>
      messages.map((m) => (
        <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
          <div
            className={
              m.role === "user"
                ? "max-w-[78%] rounded-2xl rounded-br-md bg-blue-500 px-3 py-2 text-sm text-white"
                : "max-w-[78%] rounded-2xl rounded-bl-md bg-slate-100 px-3 py-2 text-sm text-slate-800"
            }
          >
            {m.typing ? <span className="inline-flex animate-pulse">入力中...</span> : m.text}
          </div>
        </div>
      )),
    [messages],
  );

  return (
    <>
      {open ? (
        <section className="fixed bottom-24 right-4 z-[120] flex h-[70vh] w-[min(92vw,380px)] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
          <header className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3 py-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <Sparkles size={16} className="text-emerald-500" />
              AI家計アドバイザー
            </div>
            <button type="button" onClick={() => setOpen(false)} className="rounded-md p-1 text-slate-500 hover:bg-slate-200">
              <X size={16} />
            </button>
          </header>

          <div className="flex-1 space-y-2 overflow-y-auto bg-white p-3">{bubbles}</div>

          <div className="border-t border-slate-200 bg-white p-2">
            <div className="mb-2 flex justify-end">
              <button
                type="button"
                onClick={() => void runDemoMode()}
                disabled={busy}
                className="rounded-full bg-emerald-500 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
              >
                デモモード再生
              </button>
            </div>
            <div className="flex items-center gap-2">
              <input
                className="h-10 flex-1 rounded-full border border-slate-300 px-3 text-sm outline-none focus:border-emerald-400"
                placeholder="家計の相談を入力..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void onSend();
                }}
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
        className="fixed bottom-6 right-4 z-[110] flex h-14 w-14 items-center justify-center rounded-full bg-blue-500 text-white shadow-xl shadow-blue-500/30"
        aria-label="AIアドバイザーチャットを開く"
      >
        <MessageCircle size={22} />
      </button>
    </>
  );
}
