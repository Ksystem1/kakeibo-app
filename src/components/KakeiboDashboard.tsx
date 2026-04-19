import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { getEffectiveFixedCostsForMonth, useSettings } from "../context/SettingsContext";
import {
  filterCategoriesForTransactionSelect,
  isReservedLedgerFixedCostCategoryName,
} from "../lib/transactionCategories";
import {
  createTransaction,
  deleteTransaction,
  ensureDefaultCategories,
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

function parseMonthParam(search: string): string | null {
  const p = new URLSearchParams(search).get("month");
  return p && /^\d{4}-\d{2}$/.test(p) ? p : null;
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

/** 通貨記号まわりの空白をノーブレーク化し、カード内で金額が途中改行されにくくする */
function formatYenSingleLine(n: number) {
  return yen.format(n).replace(/\s/g, "\u00a0");
}

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

/** スマホ向け: MM/DD（例: 04/03） */
function formatTxDateMd(raw: string | Date | null | undefined) {
  const ymd = formatTxDateYmd(raw);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (m) return `${m[2]}/${m[3]}`;
  return ymd;
}

/** 編集用: MM/DD 入力 → YYYY-MM-DD（年は現在の取引日から継承） */
function parseMdToYmd(md: string, yearSourceYmd: string) {
  const y = /^(\d{4})/.exec(yearSourceYmd)?.[1];
  if (!y) return null;
  const m = /^(\d{1,2})[/.](\d{1,2})$/.exec(md.trim());
  if (!m) return null;
  const mo = Number.parseInt(m[1], 10);
  const d = Number.parseInt(m[2], 10);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function yearOptions() {
  const cy = new Date().getFullYear();
  const out: number[] = [];
  for (let yy = cy - 5; yy <= cy + 2; yy += 1) out.push(yy);
  return out;
}

export type KakeiboLedgerMode = "default" | "kidAllowance";

type KakeiboDashboardProps = {
  /** kidAllowance: 子ども向けお小遣い帳（見出し・一部の親向けセクションを省略） */
  ledgerMode?: KakeiboLedgerMode;
};

export function KakeiboDashboard(props?: KakeiboDashboardProps) {
  const { ledgerMode = "default" } = props ?? {};
  const isKidAllowance = ledgerMode === "kidAllowance";
  const { fixedCostsByMonth } = useSettings();
  const location = useLocation();
  const routerNavigate = useNavigate();
  const base = getApiBaseUrl();
  const txMobileNarrow = useMediaQuery("(max-width: 768px)");
  const [ym, setYm] = useState(() => parseMonthParam(location.search) ?? currentYm());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [summary, setSummary] = useState<{
    expenseTotal: unknown;
    incomeTotal: unknown;
    fixedCostFromSettings?: unknown;
    netMonthlyBalance?: unknown;
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
      const id = typeof c.id === "number" ? c.id : Number(c.id);
      if (Number.isFinite(id)) m.set(id, c.name);
    }
    return m;
  }, [categories]);

  /** 一覧のカテゴリ列が最長の表示ラベルに収まるよう 1ch 単位で渡す */
  const txCategoryMinCh = useMemo(() => {
    let m = "カテゴリ".length;
    for (const c of categories) {
      m = Math.max(m, c.name.length);
    }
    for (const t of transactions) {
      let label: string;
      if (t.category_id != null) {
        const cid =
          typeof t.category_id === "number"
            ? t.category_id
            : Number(t.category_id);
        label = Number.isFinite(cid)
          ? (categoryById.get(cid) ?? `ID:${cid}`)
          : "—";
      } else {
        label = "—";
      }
      m = Math.max(m, label.length);
    }
    return m;
  }, [categories, transactions, categoryById]);

  function normalizeCategoryRows(raw: unknown[]): Category[] {
    const out: Category[] = [];
    for (const row of raw) {
      const c = row as Record<string, unknown>;
      const idRaw = c.id;
      const id =
        typeof idRaw === "number" ? idRaw : Number(idRaw);
      if (!Number.isFinite(id) || id <= 0) continue;
      out.push({
        id,
        name: String(c.name ?? ""),
        kind:
          String(c.kind ?? "").toLowerCase() === "income"
            ? "income"
            : "expense",
      });
    }
    return out;
  }

  const load = useCallback(async () => {
    if (!base) {
      setError("VITE_API_URL が未設定です。.env を確認してください。");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      let catRes = await getCategories();
      let items = catRes.items ?? [];
      if (items.length === 0) {
        try {
          await ensureDefaultCategories();
          catRes = await getCategories();
          items = catRes.items ?? [];
        } catch {
          /* 古い API では POST が無い場合がある */
        }
      }
      const [txRes, sumRes] = await Promise.all([
        getTransactions(from, to, { scope: "family" }),
        getMonthSummary(ym, { scope: "family" }),
      ]);
      setCategories(normalizeCategoryRows(items));
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

  function handleMonthChange(nextYm: string) {
    setYm(nextYm);
    const params = new URLSearchParams(location.search);
    params.set("month", nextYm);
    routerNavigate(
      {
        pathname: location.pathname,
        search: `?${params.toString()}`,
      },
      { replace: true },
    );
  }

  const totals = useMemo(() => {
    let income = 0;
    let expense = 0;
    for (const t of transactions) {
      const a = numAmount(t.amount);
      if (t.kind === "income") income += a;
      else if (t.kind === "expense") {
        if (t.category_id != null) {
          const cid =
            typeof t.category_id === "number" ? t.category_id : Number(t.category_id);
          const nm = Number.isFinite(cid) ? categoryById.get(cid) : undefined;
          if (isReservedLedgerFixedCostCategoryName(nm)) continue;
        }
        expense += a;
      }
    }
    return { income, expense, balance: income - expense };
  }, [transactions, categoryById]);

  const incomeTotalNum = summary
    ? numAmount(summary.incomeTotal as string | number)
    : totals.income;
  const expenseTotalNum = summary
    ? numAmount(summary.expenseTotal as string | number)
    : totals.expense;
  const fixedCostItemsForMonth = getEffectiveFixedCostsForMonth(fixedCostsByMonth, ym);
  const fixedCostForMonth = fixedCostItemsForMonth.reduce((acc, x) => acc + Number(x.amount || 0), 0);
  const fixedCostForSpend =
    Number.isFinite(fixedCostForMonth) && fixedCostForMonth > 0 ? fixedCostForMonth : 0;
  /** 収入も変動費も0の月は固定費を支出合計に含めない */
  const applyFixedToSpend = incomeTotalNum > 0 || expenseTotalNum > 0;
  /** カード「支出（今月）」: 収入または変動費がある月は設定の固定費月額を加算 */
  const expenseWithFixedDisplayNum =
    expenseTotalNum + (applyFixedToSpend ? fixedCostForSpend : 0);
  const balanceNum = (() => {
    if (!summary) {
      const useFixed = totals.income > 0 || totals.expense > 0;
      return totals.income - totals.expense - (useFixed ? fixedCostForSpend : 0);
    }
    const apiNet = numAmount(summary.netMonthlyBalance as string | number);
    if (Number.isFinite(apiNet)) return apiNet;
    return (
      incomeTotalNum -
      expenseTotalNum -
      (applyFixedToSpend ? fixedCostForSpend : 0)
    );
  })();
  const expenseRowsOrdered = useMemo(() => {
    const rows = [...(summary?.expensesByCategory ?? [])];
    rows.sort(
      (a, b) =>
        numAmount(b.total as string | number) - numAmount(a.total as string | number),
    );
    return rows;
  }, [summary?.expensesByCategory]);

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
  /** モバイル編集時の日付（MM/DD）。ネイティブ date の yyyy/mm/dd 表示を避ける */
  const [mobileEditDateText, setMobileEditDateText] = useState("");
  const [fixedCostExpanded, setFixedCostExpanded] = useState(false);
  const [transactionsExpanded, setTransactionsExpanded] = useState(false);
  const mobileFixedCostInitialRows = 6;
  const txInitialRows = 5;
  const visibleFixedCostItems = useMemo(() => {
    if (!txMobileNarrow) return fixedCostItemsForMonth;
    if (fixedCostExpanded) return fixedCostItemsForMonth;
    return fixedCostItemsForMonth.slice(0, mobileFixedCostInitialRows);
  }, [txMobileNarrow, fixedCostExpanded, fixedCostItemsForMonth]);
  const visibleTransactions = useMemo(() => {
    if (transactionsExpanded) return transactions;
    return transactions.slice(0, txInitialRows);
  }, [transactionsExpanded, transactions]);

  useEffect(() => {
    setTransactionsExpanded(false);
  }, [ym]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const amount = Number.parseFloat(formAmount);
    const minAmount = formKind === "income" ? 0 : 1;
    if (!Number.isFinite(amount) || amount < minAmount) {
      setError(
        formKind === "income"
          ? "収入は 0 以上で入力してください。"
          : "支出は 1 以上で入力してください。",
      );
      return;
    }
    if (formKind === "expense" && formCategoryId) {
      const cid = Number.parseInt(formCategoryId, 10);
      const cat = categories.find((c) => c.id === cid);
      if (cat && isReservedLedgerFixedCostCategoryName(cat.name)) {
        setError("「固定費」は取引では選べません。設定画面の固定費を利用してください。");
        return;
      }
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

  const filteredCategories = filterCategoriesForTransactionSelect(
    categories.filter((c) => c.kind === formKind),
  );
  const editCategories = filterCategoriesForTransactionSelect(
    categories.filter((c) => c.kind === (edit?.kind ?? "expense")),
  );

  /** 一覧に出ない／固定費の ID が value に残るとブラウザが誤表示することがあるためクリア */
  useEffect(() => {
    if (!formCategoryId) return;
    const id = Number.parseInt(formCategoryId, 10);
    if (!Number.isFinite(id)) return;
    const cat = categories.find((c) => c.id === id);
    if (!cat || cat.kind !== formKind || isReservedLedgerFixedCostCategoryName(cat.name)) {
      setFormCategoryId("");
    }
  }, [categories, formKind, formCategoryId]);

  function beginEdit(t: Transaction) {
    const ymd = formatTxDateYmd(t.transaction_date);
    let categoryIdStr = t.category_id != null ? String(t.category_id) : "";
    if (t.kind === "expense" && t.category_id != null) {
      const cid =
        typeof t.category_id === "number" ? t.category_id : Number(t.category_id);
      const nm = Number.isFinite(cid) ? categoryById.get(cid) : undefined;
      if (isReservedLedgerFixedCostCategoryName(nm)) categoryIdStr = "";
    }
    setEdit({
      id: t.id,
      kind: t.kind === "income" ? "income" : "expense",
      amount: String(numAmount(t.amount)),
      transaction_date: ymd,
      memo: t.memo ?? "",
      category_id: categoryIdStr,
    });
    setMobileEditDateText(formatTxDateMd(t.transaction_date));
  }

  function cancelEdit() {
    setEdit(null);
    setMobileEditDateText("");
  }

  async function saveEdit() {
    if (!edit) return;
    const amount = Number.parseFloat(edit.amount);
    const minAmount = edit.kind === "income" ? 0 : 1;
    if (!Number.isFinite(amount) || amount < minAmount) {
      setError(
        edit.kind === "income"
          ? "収入は 0 以上で入力してください。"
          : "支出は 1 以上で入力してください。",
      );
      return;
    }
    if (edit.kind === "expense" && edit.category_id) {
      const cid = Number.parseInt(edit.category_id, 10);
      const cat = categories.find((c) => c.id === cid);
      if (cat && isReservedLedgerFixedCostCategoryName(cat.name)) {
        setError("「固定費」は取引では選べません。設定画面の固定費を利用してください。");
        return;
      }
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
    <>
    <div className={styles.wrap}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>{isKidAllowance ? "お小遣い帳" : "家計簿"}</h1>
          {isKidAllowance ? (
            <p className={styles.sub} style={{ marginTop: "0.35rem", maxWidth: "36rem" }}>
              自分の入出金と残金です。保護者やきょうだいとは「家族チャット」からメッセージできます。
            </p>
          ) : null}
        </div>
        <div className={styles.actions}>
          <label htmlFor={txMobileNarrow ? undefined : "kb-month"} className={styles.monthRow}>
            表示月
            {txMobileNarrow ? (
              <span className={styles.monthPickerMobile}>
                <select
                  className={styles.monthSelect}
                  aria-label="表示年"
                  value={ym.split("-")[0]}
                  onChange={(ev) => {
                    const mo = ym.split("-")[1] || "01";
                    handleMonthChange(`${ev.target.value}-${mo}`);
                  }}
                >
                  {yearOptions().map((yy) => (
                    <option key={yy} value={yy}>
                      {yy}年
                    </option>
                  ))}
                </select>
                <select
                  className={styles.monthSelect}
                  aria-label="表示月"
                  value={ym.split("-")[1] || "01"}
                  onChange={(ev) => {
                    const y = ym.split("-")[0] || String(new Date().getFullYear());
                    handleMonthChange(`${y}-${ev.target.value}`);
                  }}
                >
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((mo) => (
                    <option key={mo} value={String(mo).padStart(2, "0")}>
                      {mo}月
                    </option>
                  ))}
                </select>
              </span>
            ) : (
              <input
                id="kb-month"
                className={styles.monthInput}
                type="month"
                value={ym}
                onChange={(ev) => handleMonthChange(ev.target.value)}
                onInput={(ev) => {
                  const v = (ev.target as HTMLInputElement).value;
                  if (/^\d{4}-\d{2}$/.test(v)) handleMonthChange(v);
                }}
              />
            )}
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

      {!error && categories.length === 0 && !loading && base ? (
        <div className={styles.empty} role="status" style={{ marginBottom: "1rem" }}>
          カテゴリがまだありません。再読込しても空の場合は{" "}
          <Link to="/categories">カテゴリ管理</Link>
          から追加できます。
        </div>
      ) : null}

      <div className={styles.cards}>
        <div className={`${styles.card} ${styles.cardIncome}`}>
          <div className={styles.cardLabel} title="収入（今月）">
            収入（今月）
          </div>
          <div className={`${styles.cardValue} ${styles.income}`}>
            {formatYenSingleLine(incomeTotalNum)}
          </div>
        </div>
        <div className={`${styles.card} ${styles.cardExpense}`}>
          <div
            className={styles.cardLabel}
            title="収入または変動費（家計簿）のどちらかが0より大きい月は、ここに設定画面の固定費（月額合計）を加えた合計です。収入も変動費も無い月は固定費を含めません。"
          >
            支出（今月）
          </div>
          <div className={`${styles.cardValue} ${styles.expense}`}>
            {formatYenSingleLine(expenseWithFixedDisplayNum)}
          </div>
        </div>
        <div className={styles.card}>
          <div
            className={styles.cardLabel}
            title="収入 − 支出（今月）。収入または変動費がある月のみ支出に固定費を含め、APIの収支残金と一致します。"
          >
            残金（今月あといくら）
          </div>
          <div
            className={`${styles.cardValue} ${
              balanceNum >= 0 ? styles.balancePositive : styles.balanceNegative
            }`}
          >
            {formatYenSingleLine(balanceNum)}
          </div>
        </div>
      </div>

      {!isKidAllowance && summary && expenseRowsOrdered.length > 0 ? (
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
                {expenseRowsOrdered.map((row, i) => (
                  <tr key={`${row.category_id ?? "x"}-${i}`}>
                    <td>{row.category_name ?? "（未分類）"}</td>
                    <td>{yen.format(numAmount(row.total as string | number))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      {!isKidAllowance && fixedCostItemsForMonth.length > 0 ? (
        <>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "0.5rem",
              flexWrap: "wrap",
            }}
          >
            <h2 className={styles.sectionTitle} style={{ marginBottom: 0 }}>
              固定費明細
            </h2>
            <Link to="/settings#fixed-cost-settings" className={styles.btn}>
              固定費設定（全月共通）へ
            </Link>
          </div>
          <p className={styles.sub} style={{ margin: "0 0 0.5rem" }}>
            毎月同額のものは設定の固定費へ。取引には変動分だけを登録する運用です。
          </p>
          <div className={styles.tableWrap} style={{ marginBottom: "1rem" }}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>項目</th>
                  <th>金額</th>
                </tr>
              </thead>
              <tbody>
                {visibleFixedCostItems.map((item, i) => (
                  <tr key={`${item.id}-${i}`}>
                    <td style={{ whiteSpace: "normal", overflow: "visible", textOverflow: "clip" }}>
                      {item.category || "固定費"}
                    </td>
                    <td>{yen.format(numAmount(item.amount))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {txMobileNarrow && fixedCostItemsForMonth.length > mobileFixedCostInitialRows ? (
              <div style={{ padding: "0.45rem 0.55rem", borderTop: "1px solid var(--border)" }}>
                <button
                  type="button"
                  className={styles.btn}
                  style={{ width: "100%" }}
                  onClick={() => setFixedCostExpanded((v) => !v)}
                >
                  {fixedCostExpanded
                    ? "固定費明細を折りたたむ"
                    : `固定費明細をすべて表示（全${fixedCostItemsForMonth.length}件）`}
                </button>
              </div>
            ) : null}
          </div>
        </>
      ) : null}
      {!isKidAllowance && summary && summary.incomesByCategory.length > 0 ? (
        <>
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
                {summary.incomesByCategory.map((row, i) => (
                  <tr key={`${row.category_id ?? "y"}-${i}`}>
                    <td>{row.category_name ?? "（未分類）"}</td>
                    <td>{yen.format(numAmount(row.total as string | number))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      <h2 className={styles.sectionTitle}>取引を追加</h2>
      <form
        className={styles.form}
        data-kakeibo-tx-add
        onSubmit={handleAdd}
      >
        <div className={styles.field}>
          <label htmlFor="kb-kind">種別</label>
          <select
            id="kb-kind"
            value={formKind}
            onChange={(ev) => {
              setFormKind(ev.target.value as "expense" | "income");
              setFormCategoryId("");
            }}
          >
            <option value="expense">支出</option>
            <option value="income">収入</option>
          </select>
        </div>
        <div className={styles.field}>
          <label htmlFor="kb-cat">カテゴリ</label>
          <select
            id="kb-cat"
            key={`kb-cat-${formKind}`}
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
          <label htmlFor="kb-amt">金額</label>
          <input
            id="kb-amt"
            type="number"
            min={formKind === "income" ? 0 : 1}
            step={1}
            placeholder="1200"
            value={formAmount}
            onChange={(ev) => setFormAmount(ev.target.value)}
          />
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
        取引一覧（{from} 〜 {to} / {transactions.length}件）
      </h2>
      <div className={styles.tableWrap}>
        <table
          className={`${styles.table} ${styles.txTable}`}
          style={{ ["--tx-cat-ch" as string]: String(txCategoryMinCh) }}
        >
          <thead>
            <tr>
              <th className={styles.kindCol}>種別</th>
              <th className={styles.txColCategory}>カテゴリ</th>
              <th className={styles.txColDate}>日付</th>
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
              visibleTransactions.map((t) => {
                const isEditing = edit?.id === t.id;
                const rowKind =
                  t.kind === "income"
                    ? styles.trIncome
                    : t.kind === "expense"
                      ? styles.trExpense
                      : styles.trNeutral;

                const categoryDisplay =
                  t.category_id != null
                    ? (() => {
                        const cid =
                          typeof t.category_id === "number"
                            ? t.category_id
                            : Number(t.category_id);
                        return Number.isFinite(cid)
                          ? (categoryById.get(cid) ?? `ID:${cid}`)
                          : "—";
                      })()
                    : "—";

                if (isEditing && edit && txMobileNarrow) {
                  return (
                    <tr
                      key={t.id}
                      className={`${rowKind} ${styles.rowEditing} ${styles.mobileTxEditRow}`}
                    >
                      <td colSpan={5} className={styles.mobileTxEditCell}>
                        <div className={styles.mobileTxEdit}>
                          <div className={styles.mobileTxEditField}>
                            <span className={styles.mobileTxEditLabel}>種別</span>
                            <select
                              className={styles.mobileTxEditInput}
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
                          </div>
                          <div className={styles.mobileTxEditField}>
                            <span className={styles.mobileTxEditLabel}>カテゴリ</span>
                            <select
                              className={styles.mobileTxEditInput}
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
                          </div>
                          <div className={styles.mobileTxEditField}>
                            <span className={styles.mobileTxEditLabel}>日付</span>
                            <input
                              className={styles.mobileTxEditInput}
                              type="text"
                              inputMode="numeric"
                              placeholder="MM/DD"
                              autoComplete="off"
                              value={mobileEditDateText}
                              onChange={(ev) => {
                                const v = ev.target.value;
                                setMobileEditDateText(v);
                                const ymd = parseMdToYmd(v, edit.transaction_date);
                                if (ymd) setEdit({ ...edit, transaction_date: ymd });
                              }}
                              aria-label="取引日（月/日）"
                            />
                          </div>
                          <div className={styles.mobileTxEditField}>
                            <span className={styles.mobileTxEditLabel}>金額</span>
                            <input
                              className={styles.mobileTxEditInput}
                              type="number"
                              min={edit.kind === "income" ? 0 : 1}
                              step={1}
                              value={edit.amount}
                              onChange={(ev) =>
                                setEdit({ ...edit, amount: ev.target.value })
                              }
                              aria-label="金額"
                            />
                          </div>
                          <div className={styles.mobileTxEditField}>
                            <span className={styles.mobileTxEditLabel}>メモ</span>
                            <input
                              className={styles.mobileTxEditInput}
                              type="text"
                              value={edit.memo}
                              onChange={(ev) =>
                                setEdit({ ...edit, memo: ev.target.value })
                              }
                              placeholder="メモ"
                              aria-label="メモ"
                            />
                          </div>
                          <div className={styles.mobileTxEditActions}>
                            <button
                              type="button"
                              className={`${styles.btn} ${styles.btnPrimary}`}
                              disabled={editSaving || !base}
                              onClick={() => void saveEdit()}
                            >
                              {editSaving ? "保存中…" : "保存"}
                            </button>
                            <button
                              type="button"
                              className={styles.btn}
                              disabled={editSaving}
                              onClick={cancelEdit}
                            >
                              キャンセル
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                }

                if (txMobileNarrow && !isEditing) {
                  return (
                    <tr key={t.id} className={`${rowKind} ${styles.mobileTxViewRow}`}>
                      <td colSpan={5} className={styles.mobileTxViewCell}>
                        <div className={styles.mobileTxView}>
                          <div className={styles.mobileTxViewRow1}>
                            <span
                              className={`${styles.kind} ${styles.mobileTxViewKind} ${
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
                            <div className={styles.mobileTxViewDateAmt}>
                              <span
                                className={styles.mobileTxViewDate}
                                title={formatTxDateYmd(t.transaction_date)}
                              >
                                {formatTxDateMd(t.transaction_date)}
                              </span>
                              <span className={styles.mobileTxViewAmt}>
                                {yen.format(numAmount(t.amount))}
                              </span>
                            </div>
                            <span
                              className={styles.mobileTxViewCat}
                              title={categoryDisplay}
                            >
                              {categoryDisplay}
                            </span>
                          </div>
                          <div className={styles.mobileTxViewRow2}>
                            <span
                              className={styles.mobileTxViewMemo}
                              title={t.memo?.trim() ? t.memo : undefined}
                            >
                              {t.memo ?? ""}
                            </span>
                          </div>
                          <div className={styles.mobileTxViewActions}>
                            <button
                              type="button"
                              className={`${styles.btn} ${styles.btnSm} ${styles.mobileTxViewBtn}`}
                              disabled={!base}
                              onClick={() => beginEdit(t)}
                            >
                              変更
                            </button>
                            <button
                              type="button"
                              className={`${styles.btn} ${styles.btnSm} ${styles.btnDanger} ${styles.mobileTxViewBtn}`}
                              disabled={!base}
                              onClick={() => void removeTransaction(t.id)}
                            >
                              削除
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                }

                return (
                  <tr
                    key={t.id}
                    className={`${rowKind}${isEditing ? ` ${styles.rowEditing}` : ""}`}
                  >
                    <td className={styles.kindCol}>
                      {isEditing && edit ? (
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
                    <td className={styles.txColCategory}>
                      {isEditing && edit ? (
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
                      ) : (
                        categoryDisplay
                      )}
                    </td>
                    <td className={styles.txColDate}>
                      {isEditing && edit ? (
                        <input
                          className={`${styles.cellInput} ${styles.txDateInput}`}
                          type="date"
                          value={edit.transaction_date}
                          onChange={(ev) =>
                            setEdit({ ...edit, transaction_date: ev.target.value })
                          }
                          aria-label="取引日"
                        />
                      ) : (
                        <span
                          title={formatTxDateYmd(t.transaction_date)}
                          className={styles.txDateCell}
                        >
                          {formatTxDateMd(t.transaction_date)}
                        </span>
                      )}
                    </td>
                    <td>
                      {isEditing && edit ? (
                        <input
                          className={styles.cellInput}
                          type="number"
                          min={edit.kind === "income" ? 0 : 1}
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
                      {isEditing && edit ? (
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
        {transactions.length > txInitialRows ? (
          <div style={{ padding: "0.45rem 0.55rem", borderTop: "1px solid var(--border)" }}>
            <button
              type="button"
              className={styles.btn}
              style={{ width: "100%" }}
              onClick={() => setTransactionsExpanded((v) => !v)}
            >
              {transactionsExpanded
                ? "取引一覧を折りたたむ"
                : `取引一覧をすべて表示（全${transactions.length}件）`}
            </button>
          </div>
        ) : null}
      </div>
    </div>
    </>
  );
}
