import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Candy, Gift, ShoppingCart, Sparkles } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { celebrateKidTransactionSaved } from "../lib/kidConfetti";
import {
  createTransaction,
  ensureDefaultCategories,
  getApiBaseUrl,
  getCategories,
  getMonthSummary,
  getTransactions,
  type KidTheme,
} from "../lib/api";
import styles from "./SimpleKidDashboard.module.css";

type Category = { id: number; name: string; kind: "income" | "expense" };
type Transaction = {
  id: number;
  category_id: number | null;
  kind: string;
  amount: string | number;
  transaction_date: string;
  memo: string | null;
};

function currentYm() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function ymToRange(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  const from = `${y}-${String(m).padStart(2, "0")}-01`;
  const last = new Date(y, m, 0).getDate();
  const to = `${y}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
  return { from, to };
}

function todayYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function numAmount(v: string | number) {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

const yen = new Intl.NumberFormat("ja-JP", {
  style: "currency",
  currency: "JPY",
  maximumFractionDigits: 0,
});

function normalizeCategories(raw: unknown[]): Category[] {
  const out: Category[] = [];
  for (const row of raw) {
    const c = row as Record<string, unknown>;
    const id = typeof c.id === "number" ? c.id : Number(c.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    out.push({
      id,
      name: String(c.name ?? ""),
      kind: String(c.kind ?? "").toLowerCase() === "income" ? "income" : "expense",
    });
  }
  return out;
}

export function SimpleKidDashboard() {
  const { user } = useAuth();
  const base = getApiBaseUrl();
  const theme: KidTheme = user?.kidTheme === "pink" ? "pink" : "blue";
  const rootClass = theme === "pink" ? styles.rootPink : styles.rootBlue;

  const [ym, setYm] = useState(currentYm);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [summary, setSummary] = useState<{
    incomeTotal: unknown;
    expenseTotal: unknown;
    netMonthlyBalance?: unknown;
  } | null>(null);

  const [formKind, setFormKind] = useState<"income" | "expense">("expense");
  const [formAmount, setFormAmount] = useState("");
  /** 「なにに？」— カテゴリは選ばず、手入力の内容をメモとして保存 */
  const [formWhat, setFormWhat] = useState("");
  const [formDate, setFormDate] = useState(todayYmd);
  const [saving, setSaving] = useState(false);

  const { from, to } = useMemo(() => ymToRange(ym), [ym]);

  const categoryById = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of categories) m.set(c.id, c.name);
    return m;
  }, [categories]);

  const load = useCallback(async () => {
    if (!base) {
      setError("API の設定を確認してください。");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      let catRes = await getCategories();
      let items = catRes.items ?? [];
      if (items.length === 0) {
        try {
          await ensureDefaultCategories();
          catRes = await getCategories();
          items = catRes.items ?? [];
        } catch {
          /* ignore */
        }
      }
      const [txRes, sumRes] = await Promise.all([
        getTransactions(from, to),
        getMonthSummary(ym),
      ]);
      setCategories(normalizeCategories(items));
      setTransactions((txRes.items ?? []) as Transaction[]);
      setSummary(sumRes);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setTransactions([]);
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [base, from, to, ym]);

  useEffect(() => {
    void load();
  }, [load]);

  const incomeTotal = summary ? numAmount(summary.incomeTotal as string | number) : 0;
  const expenseTotal = summary ? numAmount(summary.expenseTotal as string | number) : 0;
  const balance =
    summary && summary.netMonthlyBalance != null && summary.netMonthlyBalance !== ""
      ? numAmount(summary.netMonthlyBalance as string | number)
      : incomeTotal - expenseTotal;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const amount = Number.parseInt(formAmount, 10);
    if (!Number.isFinite(amount) || amount < (formKind === "income" ? 0 : 1)) {
      setError(formKind === "income" ? "金額は 0 以上の整数でね" : "金額は 1 円以上の整数でね");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await createTransaction({
        kind: formKind,
        amount,
        transaction_date: formDate,
        memo: formWhat.trim() || null,
        category_id: null,
      });
      celebrateKidTransactionSaved(theme);
      setFormAmount("");
      setFormWhat("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={rootClass}>
      <div className={styles.hero}>
        <h1 className={styles.heroTitle}>お小遣い帳</h1>
        <p className={styles.heroSub}>簡単に記録しよう！</p>
      </div>

      <div className={styles.monthRow}>
        <label htmlFor="kid-month" className={styles.field}>
          <span className={styles.cardLabel}>月</span>
          <input
            id="kid-month"
            className={styles.monthInput}
            type="month"
            value={ym}
            onChange={(ev) => setYm(ev.target.value)}
          />
        </label>
        <button type="button" className={styles.reloadBtn} disabled={loading} onClick={() => void load()}>
          {loading ? "読み込み中…" : "更新"}
        </button>
      </div>

      {error ? (
        <div className={styles.err} role="alert">
          {error}
        </div>
      ) : null}

      <div className={styles.cards}>
        <div className={styles.card}>
          <div className={styles.cardLabel}>もらった</div>
          <div className={styles.cardValue}>{yen.format(incomeTotal)}</div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardLabel}>使った</div>
          <div className={styles.cardValue}>{yen.format(expenseTotal)}</div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardLabel}>残り</div>
          <div className={styles.cardValue}>{yen.format(balance)}</div>
        </div>
      </div>

      <h2 className={styles.sectionTitle}>記録する</h2>
      <form className={styles.addCard} onSubmit={onSubmit}>
        <div className={styles.kindRow}>
          <button
            type="button"
            className={`${styles.kindBtnIncome} ${formKind === "income" ? styles.kindBtnSelected : ""}`}
            onClick={() => setFormKind("income")}
          >
            <span className={styles.kindIconRow} aria-hidden>
              <Gift className={styles.kindLucideMain} strokeWidth={2.25} />
              <Sparkles className={styles.kindLucideAccent} strokeWidth={2.5} />
            </span>
            もらった
          </button>
          <button
            type="button"
            className={`${styles.kindBtnExpense} ${formKind === "expense" ? styles.kindBtnSelected : ""}`}
            onClick={() => setFormKind("expense")}
          >
            <span className={styles.kindIconRow} aria-hidden>
              <ShoppingCart className={styles.kindLucideMain} strokeWidth={2.25} />
              <Candy className={styles.kindLucideAccent} strokeWidth={2.4} />
            </span>
            使った
          </button>
        </div>
        <div className={styles.fieldRow}>
          <div className={styles.field}>
            <label htmlFor="kid-amt">お金（円）</label>
            <input
              id="kid-amt"
              className={styles.input}
              inputMode="numeric"
              type="number"
              min={formKind === "income" ? 0 : 1}
              step={1}
              value={formAmount}
              onChange={(ev) => setFormAmount(ev.target.value)}
              placeholder="100"
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="kid-day">日付</label>
            <input
              id="kid-day"
              className={styles.input}
              type="date"
              value={formDate}
              onChange={(ev) => setFormDate(ev.target.value)}
            />
          </div>
        </div>
        <div className={styles.fieldRow}>
          <div className={styles.field} style={{ flex: "1 1 100%", maxWidth: "100%" }}>
            <label htmlFor="kid-what">なにに？</label>
            <input
              id="kid-what"
              className={styles.input}
              type="text"
              maxLength={200}
              value={formWhat}
              onChange={(ev) => setFormWhat(ev.target.value)}
              placeholder="おやつ、おもちゃ、おつり…"
              autoComplete="off"
            />
          </div>
        </div>
        <button type="submit" className={styles.submitBtn} disabled={saving || loading}>
          {saving ? "登録中…" : "登録！"}
        </button>
      </form>

      <h2 className={styles.sectionTitle}>これまでの記録</h2>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>日</th>
              <th>内容</th>
              <th>金額</th>
            </tr>
          </thead>
          <tbody>
            {transactions.length === 0 ? (
              <tr>
                <td colSpan={3} style={{ textAlign: "center", color: "var(--kid-muted)" }}>
                  まだ記録がありません
                </td>
              </tr>
            ) : (
              [...transactions]
                .sort(
                  (a, b) =>
                    String(b.transaction_date).localeCompare(String(a.transaction_date)) ||
                    b.id - a.id,
                )
                .map((t) => {
                  const cid =
                    t.category_id != null
                      ? typeof t.category_id === "number"
                        ? t.category_id
                        : Number(t.category_id)
                      : null;
                  const catLabel =
                    cid != null && Number.isFinite(cid) ? categoryById.get(cid) ?? "" : "";
                  const memoStr = t.memo != null && String(t.memo).trim() !== "" ? String(t.memo).trim() : "";
                  const whatLabel = memoStr || catLabel || "—";
                  const day = String(t.transaction_date).slice(0, 10);
                  return (
                    <tr key={t.id}>
                      <td>{day}</td>
                      <td>
                        <span className={styles.txKindIcons} aria-hidden>
                          {t.kind === "income" ? (
                            <>
                              <Gift size={17} strokeWidth={2.2} />
                              <Sparkles size={15} strokeWidth={2.4} />
                            </>
                          ) : (
                            <>
                              <ShoppingCart size={17} strokeWidth={2.2} />
                              <Candy size={15} strokeWidth={2.4} />
                            </>
                          )}
                        </span>
                        {whatLabel}
                      </td>
                      <td>{yen.format(numAmount(t.amount))}</td>
                    </tr>
                  );
                })
            )}
          </tbody>
        </table>
      </div>

    </div>
  );
}
