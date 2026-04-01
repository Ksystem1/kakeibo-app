import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createTransaction,
  deleteTransaction,
  getApiBaseUrl,
  getCategories,
  getMonthSummary,
  getTransactions,
  updateTransaction,
} from "../lib/api";
import styles from "./KakeiboDashboard.module.css";

type Category = {
  id: number;
  name: string;
  kind: string;
};

type Transaction = {
  id: number;
  category_id: number | null;
  kind: string;
  amount: string | number;
  transaction_date: string;
  memo: string | null;
};

function ymToRange(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  const from = `${y}-${String(m).padStart(2, "0")}-01`;
  const last = new Date(y, m, 0).getDate();
  const to = `${y}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
  return { from, to };
}

function currentYm() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function todayDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const yen = new Intl.NumberFormat("ja-JP", {
  style: "currency",
  currency: "JPY",
  maximumFractionDigits: 0,
});

function numAmount(v: string | number) {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

/** 取引一覧の日付を YYYY-MM-DD のみ表示 */
function formatTxDateYmd(raw: string | Date | null | undefined) {
  if (raw == null) return "";
  const s = typeof raw === "string" ? raw : raw.toISOString?.() ?? String(raw);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (m) return m[1];
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 10);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

export function KakeiboDashboard() {
  const base = getApiBaseUrl();
  const [ym, setYm] = useState(currentYm);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [summary, setSummary] = useState<{
    expenseTotal: unknown;
    incomeTotal: unknown;
    expensesByCategory: Array<{
      category_id: number | null;
      category_name: string | null;
      total: unknown;
    }>;
    incomesByCategory: Array<{
      category_id: number | null;
      category_name: string | null;
      total: unknown;
    }>;
  } | null>(null);

  const { from, to } = useMemo(() => ymToRange(ym), [ym]);

  const categoryById = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of categories) {
      m.set(c.id, c.name);
    }
    return m;
  }, [categories]);

  const load = useCallback(async () => {
    if (!base) {
      setError("VITE_API_URL が未設定です。.env を確認してください。");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const [catRes, txRes, sumRes] = await Promise.all([
        getCategories(),
        getTransactions(from, to),
        getMonthSummary(ym),
      ]);
      setCategories((catRes.items ?? []) as Category[]);
      setTransactions((txRes.items ?? []) as Transaction[]);
      setSummary(sumRes);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setTransactions([]);
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [base, from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(() => {
    let income = 0;
    let expense = 0;
    for (const t of transactions) {
      const a = numAmount(t.amount);
      if (t.kind === "income") income += a;
      else if (t.kind === "expense") expense += a;
    }
    return { income, expense, balance: income - expense };
  }, [transactions]);

  const [formAmount, setFormAmount] = useState("");
  const [formKind, setFormKind] = useState<"expense" | "income">("expense");
  const [formDate, setFormDate] = useState(todayDate);
  const [formMemo, setFormMemo] = useState("");
  const [formCategoryId, setFormCategoryId] = useState<string>("");
  const [saving, setSaving] = useState(false);

  const [edit, setEdit] = useState<{
    id: number;
    kind: "expense" | "income";
    amount: string;
    transaction_date: string;
    memo: string;
    category_id: string;
  } | null>(null);
  const [editSaving, setEditSaving] = useState(false);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const amount = Number.parseFloat(formAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError("金額は正の数で入力してください。");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await createTransaction({
        kind: formKind,
        amount,
        transaction_date: formDate,
        memo: formMemo.trim() || null,
        category_id: formCategoryId
          ? Number.parseInt(formCategoryId, 10)
          : null,
      });
      setFormAmount("");
      setFormMemo("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const filteredCategories = categories.filter((c) => c.kind === formKind);
  const editCategories = categories.filter(
    (c) => c.kind === (edit?.kind ?? "expense"),
  );

  function beginEdit(t: Transaction) {
    setEdit({
      id: t.id,
      kind: t.kind === "income" ? "income" : "expense",
      amount: String(numAmount(t.amount)),
      transaction_date: formatTxDateYmd(t.transaction_date),
      memo: t.memo ?? "",
      category_id: t.category_id != null ? String(t.category_id) : "",
    });
  }

  function cancelEdit() {
    setEdit(null);
  }

  async function saveEdit() {
    if (!edit) return;
    const amount = Number.parseFloat(edit.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError("金額は正の数で入力してください。");
      return;
    }
    setEditSaving(true);
    setError(null);
    try {
      await updateTransaction(edit.id, {
        kind: edit.kind,
        amount,
        transaction_date: edit.transaction_date,
        memo: edit.memo.trim() || null,
        category_id: edit.category_id
          ? Number.parseInt(edit.category_id, 10)
          : null,
      });
      cancelEdit();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setEditSaving(false);
    }
  }

  async function removeTransaction(id: number) {
    if (!window.confirm("この取引を削除しますか？")) return;
    setError(null);
    try {
      await deleteTransaction(id);
      if (edit?.id === id) cancelEdit();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className={styles.wrap}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>家計簿</h1>
        </div>
        <div className={styles.actions}>
          <label htmlFor="kb-month" className={styles.monthRow}>
            表示月
            <input
              id="kb-month"
              className={styles.monthInput}
              type="month"
              value={ym}
              onChange={(ev) => setYm(ev.target.value)}
            />
          </label>
          <button
            type="button"
            className={styles.btn}
            disabled={loading || !base}
            onClick={() => void load()}
          >
            {loading ? "読込中…" : "再読込"}
          </button>
        </div>
      </header>

      {error ? (
        <div className={styles.err} role="alert">
          {error}
        </div>
      ) : null}

      <div className={styles.cards}>
        <div className={styles.card}>
          <div className={styles.cardLabel}>収入（今月）</div>
          <div className={`${styles.cardValue} ${styles.income}`}>
            {yen.format(
              summary
                ? numAmount(summary.incomeTotal as string | number)
                : totals.income,
            )}
          </div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardLabel}>支出（今月）</div>
          <div className={`${styles.cardValue} ${styles.expense}`}>
            {yen.format(
              summary
                ? numAmount(summary.expenseTotal as string | number)
                : totals.expense,
            )}
          </div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardLabel}>収支</div>
          <div className={styles.cardValue}>
            {yen.format(
              (summary
                ? numAmount(summary.incomeTotal as string | number)
                : totals.income) -
                (summary
                  ? numAmount(summary.expenseTotal as string | number)
                  : totals.expense),
            )}
          </div>
        </div>
      </div>

      {summary ? (
        <>
          <h2 className={styles.sectionTitle}>品目別・支出（API集計）</h2>
          <div className={styles.tableWrap} style={{ marginBottom: "1rem" }}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>カテゴリ</th>
                  <th>合計</th>
                </tr>
              </thead>
              <tbody>
                {summary.expensesByCategory.length === 0 ? (
                  <tr>
                    <td colSpan={2}>
                      <div className={styles.empty}>データなし</div>
                    </td>
                  </tr>
                ) : (
                  summary.expensesByCategory.map((row, i) => (
                    <tr
                      key={`${row.category_id ?? "x"}-${i}`}
                    >
                      <td>{row.category_name ?? "（未分類）"}</td>
                      <td>{yen.format(numAmount(row.total as string | number))}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <h2 className={styles.sectionTitle}>品目別・収入（API集計）</h2>
          <div className={styles.tableWrap} style={{ marginBottom: "1.25rem" }}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>カテゴリ</th>
                  <th>合計</th>
                </tr>
              </thead>
              <tbody>
                {summary.incomesByCategory.length === 0 ? (
                  <tr>
                    <td colSpan={2}>
                      <div className={styles.empty}>データなし</div>
                    </td>
                  </tr>
                ) : (
                  summary.incomesByCategory.map((row, i) => (
                    <tr key={`${row.category_id ?? "y"}-${i}`}>
                      <td>{row.category_name ?? "（未分類）"}</td>
                      <td>{yen.format(numAmount(row.total as string | number))}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      <h2 className={styles.sectionTitle}>取引を追加</h2>
      <form className={styles.form} onSubmit={handleAdd}>
        <div className={styles.field}>
          <label htmlFor="kb-kind">種別</label>
          <select
            id="kb-kind"
            value={formKind}
            onChange={(ev) =>
              setFormKind(ev.target.value as "expense" | "income")
            }
          >
            <option value="expense">支出</option>
            <option value="income">収入</option>
          </select>
        </div>
        <div className={styles.field}>
          <label htmlFor="kb-amt">金額</label>
          <input
            id="kb-amt"
            type="number"
            min={1}
            step={1}
            placeholder="1200"
            value={formAmount}
            onChange={(ev) => setFormAmount(ev.target.value)}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="kb-date">日付</label>
          <input
            id="kb-date"
            type="date"
            value={formDate}
            onChange={(ev) => setFormDate(ev.target.value)}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="kb-cat">カテゴリ（任意）</label>
          <select
            id="kb-cat"
            value={formCategoryId}
            onChange={(ev) => setFormCategoryId(ev.target.value)}
          >
            <option value="">なし</option>
            {filteredCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field} style={{ gridColumn: "1 / -1" }}>
          <label htmlFor="kb-memo">メモ</label>
          <input
            id="kb-memo"
            type="text"
            placeholder="内容"
            value={formMemo}
            onChange={(ev) => setFormMemo(ev.target.value)}
          />
        </div>
        <button
          type="submit"
          className={`${styles.btn} ${styles.btnPrimary}`}
          disabled={saving || !base}
        >
          {saving ? "保存中…" : "追加"}
        </button>
      </form>

      <h2 className={styles.sectionTitle}>
        取引一覧（{from} 〜 {to}）
      </h2>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>日付</th>
              <th>種別</th>
              <th>カテゴリ</th>
              <th>金額</th>
              <th>メモ</th>
            </tr>
          </thead>
          <tbody>
            {transactions.length === 0 ? (
              <tr>
                <td colSpan={5}>
                  <div className={styles.empty}>
                    この月の取引はまだありません。上のフォームから追加するか、別画面で登録済みか確認してください。
                  </div>
                </td>
              </tr>
            ) : (
              transactions.map((t) => {
                const isEditing = edit?.id === t.id;
                return (
                  <tr key={t.id}>
                    <td>
                      {isEditing ? (
                        <input
                          className={styles.cellInput}
                          type="date"
                          value={edit.transaction_date}
                          onChange={(ev) =>
                            setEdit({ ...edit, transaction_date: ev.target.value })
                          }
                          aria-label="取引日"
                        />
                      ) : (
                        formatTxDateYmd(t.transaction_date)
                      )}
                    </td>
                    <td>
                      {isEditing ? (
                        <select
                          className={styles.cellInput}
                          value={edit.kind}
                          onChange={(ev) =>
                            setEdit({
                              ...edit,
                              kind: ev.target.value as "expense" | "income",
                              category_id: "",
                            })
                          }
                          aria-label="種別"
                        >
                          <option value="expense">支出</option>
                          <option value="income">収入</option>
                        </select>
                      ) : (
                        <span
                          className={`${styles.kind} ${
                            t.kind === "income"
                              ? styles.kindIncome
                              : t.kind === "expense"
                                ? styles.kindExpense
                                : styles.kindOther
                          }`}
                        >
                          {t.kind === "income"
                            ? "収入"
                            : t.kind === "expense"
                              ? "支出"
                              : t.kind}
                        </span>
                      )}
                    </td>
                    <td>
                      {isEditing ? (
                        <select
                          className={styles.cellInput}
                          value={edit.category_id}
                          onChange={(ev) =>
                            setEdit({ ...edit, category_id: ev.target.value })
                          }
                          aria-label="カテゴリ"
                        >
                          <option value="">なし</option>
                          {editCategories.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      ) : t.category_id != null ? (
                        categoryById.get(t.category_id) ?? `ID:${t.category_id}`
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      {isEditing ? (
                        <input
                          className={styles.cellInput}
                          type="number"
                          min={1}
                          step={1}
                          value={edit.amount}
                          onChange={(ev) =>
                            setEdit({ ...edit, amount: ev.target.value })
                          }
                          aria-label="金額"
                        />
                      ) : (
                        yen.format(numAmount(t.amount))
                      )}
                    </td>
                    <td>
                      {isEditing ? (
                        <div className={styles.memoCell}>
                          <input
                            className={styles.cellInput}
                            type="text"
                            value={edit.memo}
                            onChange={(ev) =>
                              setEdit({ ...edit, memo: ev.target.value })
                            }
                            placeholder="メモ"
                            aria-label="メモ"
                          />
                          <div className={styles.rowActions}>
                            <button
                              type="button"
                              className={`${styles.btn} ${styles.btnSm} ${styles.btnPrimary}`}
                              disabled={editSaving || !base}
                              onClick={() => void saveEdit()}
                            >
                              {editSaving ? "保存中…" : "保存"}
                            </button>
                            <button
                              type="button"
                              className={`${styles.btn} ${styles.btnSm}`}
                              disabled={editSaving}
                              onClick={cancelEdit}
                            >
                              キャンセル
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className={styles.memoCell}>
                          <span className={styles.memoText}>
                            {t.memo ?? ""}
                          </span>
                          <div className={styles.rowActions}>
                            <button
                              type="button"
                              className={`${styles.btn} ${styles.btnSm}`}
                              disabled={!base}
                              onClick={() => beginEdit(t)}
                            >
                              変更
                            </button>
                            <button
                              type="button"
                              className={`${styles.btn} ${styles.btnSm} ${styles.btnDanger}`}
                              disabled={!base}
                              onClick={() => void removeTransaction(t.id)}
                            >
                              削除
                            </button>
                          </div>
                        </div>
                      )}
                    </td>
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
