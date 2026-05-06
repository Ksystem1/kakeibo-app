import { type CSSProperties, type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Candy, Gift, Pencil, ShoppingCart, Sparkles, Trash2 } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { celebrateKidTransactionSaved } from "../lib/kidConfetti";
import {
  createTransaction,
  deleteTransaction,
  ensureDefaultCategories,
  getApiBaseUrl,
  getCategories,
  getMonthSummary,
  getTransactions,
  updateMyKidTheme,
  updateTransaction,
  type KidTheme,
} from "../lib/api";
import type { PuzzleHint } from "../lib/generateMathPuzzle";
import { ChildGame } from "./ChildGame";
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

type KidThemeDefinition = {
  label: string;
  familyLabel: string;
  bg: string;
  surface: string;
  accent: string;
  accent2: string;
  text: string;
  muted: string;
  iconInline: string;
};

const KID_THEME_DEFINITIONS: Record<KidTheme, KidThemeDefinition> = {
  pink: {
    label: "ピンク",
    familyLabel: "女の子向け",
    bg: "linear-gradient(165deg, #fff0f7 0%, #fff5fb 45%, #fffbeb 100%)",
    surface: "rgba(255, 255, 255, 0.9)",
    accent: "#e88aaf",
    accent2: "#ffc4d9",
    text: "#7a3d58",
    muted: "#9b5c78",
    iconInline: "#c45b8a",
  },
  lavender: {
    label: "ラベンダー",
    familyLabel: "女の子向け",
    bg: "linear-gradient(165deg, #f3ecff 0%, #f8f4ff 48%, #fff9f0 100%)",
    surface: "rgba(255, 255, 255, 0.92)",
    accent: "#9a7de0",
    accent2: "#d8c8ff",
    text: "#4f3a76",
    muted: "#766194",
    iconInline: "#7e67bf",
  },
  pastel_yellow: {
    label: "パステルイエロー",
    familyLabel: "女の子向け",
    bg: "linear-gradient(165deg, #fffbe0 0%, #fffdf2 45%, #fff4ea 100%)",
    surface: "rgba(255, 255, 255, 0.9)",
    accent: "#e5be52",
    accent2: "#f9df92",
    text: "#6f5830",
    muted: "#8f7447",
    iconInline: "#c79f32",
  },
  mint_green: {
    label: "ミントグリーン",
    familyLabel: "女の子向け",
    bg: "linear-gradient(165deg, #e8fff5 0%, #f2fff9 45%, #f0faff 100%)",
    surface: "rgba(255, 255, 255, 0.92)",
    accent: "#5bbf9f",
    accent2: "#9be7cf",
    text: "#2f6d5c",
    muted: "#4b8f7c",
    iconInline: "#419a80",
  },
  floral: {
    label: "フローラル",
    familyLabel: "女の子向け",
    bg: "linear-gradient(165deg, #fff1f7 0%, #f4fff3 40%, #fff7ec 100%)",
    surface: "rgba(255, 255, 255, 0.9)",
    accent: "#d979a4",
    accent2: "#f5b8d7",
    text: "#674057",
    muted: "#8f6480",
    iconInline: "#ba5e88",
  },
  blue: {
    label: "ブルー",
    familyLabel: "男の子向け",
    bg: "linear-gradient(165deg, #e8f4ff 0%, #f3f0ff 42%, #fff8f0 100%)",
    surface: "rgba(255, 255, 255, 0.9)",
    accent: "#6b93d6",
    accent2: "#a8c8f0",
    text: "#3d4f6f",
    muted: "#6a7d99",
    iconInline: "#5b7eb8",
  },
  navy: {
    label: "ネイビー",
    familyLabel: "男の子向け",
    bg: "linear-gradient(165deg, #dfe8ff 0%, #edf3ff 44%, #f7f8ff 100%)",
    surface: "rgba(255, 255, 255, 0.9)",
    accent: "#4961b9",
    accent2: "#8ea2eb",
    text: "#273561",
    muted: "#4d5f8a",
    iconInline: "#394f97",
  },
  dino_green: {
    label: "ダイナソーグリーン",
    familyLabel: "男の子向け",
    bg: "linear-gradient(165deg, #e7ffe8 0%, #f0fff0 45%, #ecfff8 100%)",
    surface: "rgba(255, 255, 255, 0.9)",
    accent: "#52a66d",
    accent2: "#9ed8ad",
    text: "#2f5f3d",
    muted: "#4f7f5a",
    iconInline: "#3e8754",
  },
  space_black: {
    label: "スペースブラック",
    familyLabel: "男の子向け",
    bg: "linear-gradient(165deg, #0f172a 0%, #1e293b 45%, #111827 100%)",
    surface: "rgba(30, 41, 59, 0.82)",
    accent: "#6366f1",
    accent2: "#818cf8",
    text: "#e5e7eb",
    muted: "#c7d2fe",
    iconInline: "#a5b4fc",
  },
  sky_red: {
    label: "スカイレッド",
    familyLabel: "男の子向け",
    bg: "linear-gradient(165deg, #e8f2ff 0%, #f4f8ff 35%, #ffe9e5 100%)",
    surface: "rgba(255, 255, 255, 0.9)",
    accent: "#de5f52",
    accent2: "#f29d95",
    text: "#6b3731",
    muted: "#94605a",
    iconInline: "#bf4d42",
  },
};

export function SimpleKidDashboard() {
  const { user, setUser } = useAuth();
  const base = getApiBaseUrl();
  const theme: KidTheme = user?.kidTheme ?? "blue";
  const themeDef = KID_THEME_DEFINITIONS[theme] ?? KID_THEME_DEFINITIONS.blue;
  const [themeSaving, setThemeSaving] = useState(false);

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
  /** 「何に？」— カテゴリは選ばず、手入力の内容をメモとして保存 */
  const [formWhat, setFormWhat] = useState("");
  const [formDate, setFormDate] = useState(todayYmd);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [showGameReward, setShowGameReward] = useState(false);
  const [latestGameHint, setLatestGameHint] = useState<PuzzleHint | null>(null);

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

  useEffect(() => {
    setEditingId(null);
    setFormAmount("");
    setFormWhat("");
    setFormDate(todayYmd());
    setFormKind("expense");
  }, [ym]);

  useEffect(() => {
    if (latestGameHint) return;
    const latestExpense = [...transactions]
      .filter((t) => String(t.kind).toLowerCase() === "expense")
      .sort(
        (a, b) =>
          String(b.transaction_date).localeCompare(String(a.transaction_date)) || b.id - a.id,
      )[0];
    if (!latestExpense) return;
    setLatestGameHint({
      amount: Math.max(0, Math.round(numAmount(latestExpense.amount))),
      memo: latestExpense.memo,
    });
  }, [transactions, latestGameHint]);

  const incomeTotal = summary ? numAmount(summary.incomeTotal as string | number) : 0;
  const expenseTotal = summary ? numAmount(summary.expenseTotal as string | number) : 0;
  const balance =
    summary && summary.netMonthlyBalance != null && summary.netMonthlyBalance !== ""
      ? numAmount(summary.netMonthlyBalance as string | number)
      : incomeTotal - expenseTotal;

  function cancelEdit() {
    setEditingId(null);
    setFormAmount("");
    setFormWhat("");
    setFormDate(todayYmd());
    setFormKind("expense");
    setError(null);
  }

  function beginEdit(t: Transaction) {
    const k = String(t.kind).toLowerCase() === "income" ? "income" : "expense";
    setEditingId(t.id);
    setFormKind(k);
    setFormAmount(String(Math.round(numAmount(t.amount))));
    setFormDate(String(t.transaction_date).slice(0, 10));
    setFormWhat(t.memo != null && String(t.memo).trim() !== "" ? String(t.memo).trim() : "");
    setError(null);
  }

  async function onDeleteRow(id: number) {
    if (!window.confirm("この記録を消しますか？")) return;
    setDeletingId(id);
    setError(null);
    try {
      await deleteTransaction(id);
      if (editingId === id) cancelEdit();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingId(null);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const amount = Number.parseInt(formAmount, 10);
    if (!Number.isFinite(amount) || amount < (formKind === "income" ? 0 : 1)) {
      setError(formKind === "income" ? "金額は 0 以上の整数でね" : "金額は 1 円以上の整数でね");
      return;
    }
    setSaving(true);
    setError(null);
    const newHint: PuzzleHint = {
      amount,
      memo: formWhat.trim() || null,
    };
    try {
      if (editingId != null) {
        await updateTransaction(editingId, {
          kind: formKind,
          amount,
          transaction_date: formDate,
          memo: formWhat.trim() || null,
        });
        celebrateKidTransactionSaved(theme);
        cancelEdit();
      } else {
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
      }
      setShowGameReward(true);
      setLatestGameHint(newHint);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className={styles.root}
      style={
        {
          "--kid-bg": themeDef.bg,
          "--kid-surface": themeDef.surface,
          "--kid-accent": themeDef.accent,
          "--kid-accent2": themeDef.accent2,
          "--kid-text": themeDef.text,
          "--kid-muted": themeDef.muted,
          "--kid-icon-inline": themeDef.iconInline,
        } as CSSProperties
      }
    >
      <div className={styles.hero}>
        <h1 className={styles.heroTitle}>おこづかい帳</h1>
        <p className={styles.heroSub}>簡単に記録しよう！</p>
      </div>

      <div className={styles.themePanel}>
        <h2 className={styles.themePanelTitle}>テーマ変更</h2>
        <p className={styles.themePanelSub}>好きな色を選ぶと、すぐに画面に反映されます。</p>
        <div className={styles.themeChoices} role="radiogroup" aria-label="おこづかい帳のテーマ">
          {(Object.entries(KID_THEME_DEFINITIONS) as Array<[KidTheme, KidThemeDefinition]>).map(
            ([themeId, def]) => (
              <button
                key={themeId}
                type="button"
                className={`${styles.themeChoice} ${theme === themeId ? styles.themeChoiceSelected : ""}`}
                onClick={async () => {
                  if (themeId === theme || themeSaving) return;
                  setThemeSaving(true);
                  setError(null);
                  try {
                    await updateMyKidTheme(themeId);
                    setUser(user ? { ...user, kidTheme: themeId } : user);
                  } catch (err) {
                    setError(err instanceof Error ? err.message : String(err));
                  } finally {
                    setThemeSaving(false);
                  }
                }}
                disabled={themeSaving}
                aria-checked={theme === themeId}
                role="radio"
                title={`${def.label}（${def.familyLabel}）`}
              >
                <span className={styles.themePreview} style={{ background: def.bg }} aria-hidden />
                <span className={styles.themeChoiceText}>
                  <strong>{def.label}</strong>
                  <small>{def.familyLabel}</small>
                </span>
              </button>
            ),
          )}
        </div>
      </div>

      <div className={styles.monthRow}>
        <label htmlFor="kid-month" className={styles.field}>
          <span className={styles.cardLabel}>月</span>
          <input
            id="kid-month"
            className={styles.monthInput}
            type="month"
            required
            value={ym}
            onChange={(ev) => {
              if (ev.target.value) setYm(ev.target.value);
            }}
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

      <h2 className={styles.sectionTitle}>{editingId != null ? "記録を変更" : "記録する"}</h2>
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
            <label htmlFor="kid-what">何に？</label>
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
        <div className={styles.submitRow}>
          {editingId != null ? (
            <button type="button" className={styles.cancelBtn} disabled={saving} onClick={cancelEdit}>
              戻る
            </button>
          ) : null}
          <button type="submit" className={styles.submitBtn} disabled={saving || loading}>
            {saving ? (editingId != null ? "保存中…" : "登録中…") : editingId != null ? "保存！" : "登録！"}
          </button>
        </div>
      </form>
      {showGameReward ? (
        <ChildGame gradeGroup={user?.gradeGroup} ledgerHint={latestGameHint} />
      ) : (
        <div style={{ marginTop: "0.85rem" }}>
          <button
            type="button"
            className={styles.submitBtn}
            onClick={() => setShowGameReward(true)}
          >
            ごほうびゲームをあそぶ
          </button>
        </div>
      )}

      <h2 className={styles.sectionTitle}>これまでの記録</h2>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>日</th>
              <th>内容</th>
              <th>金額</th>
              <th className={styles.thActions} scope="col">
                操作
              </th>
            </tr>
          </thead>
          <tbody>
            {transactions.length === 0 ? (
              <tr>
                <td colSpan={4} style={{ textAlign: "center", color: "var(--kid-muted)" }}>
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
                    <tr
                      key={t.id}
                      className={editingId === t.id ? styles.tableRowEditing : undefined}
                    >
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
                      <td className={styles.tdActions}>
                        <div className={styles.rowActions}>
                          <button
                            type="button"
                            className={styles.rowActionBtn}
                            disabled={loading || saving || deletingId != null}
                            title="変更"
                            aria-label="この記録を変更"
                            onClick={() => beginEdit(t)}
                          >
                            <Pencil size={18} strokeWidth={2.2} />
                          </button>
                          <button
                            type="button"
                            className={`${styles.rowActionBtn} ${styles.rowActionBtnDelete}`}
                            disabled={loading || saving || deletingId != null}
                            title="削除"
                            aria-label="この記録を削除"
                            onClick={() => void onDeleteRow(t.id)}
                          >
                            <Trash2 size={18} strokeWidth={2.2} />
                          </button>
                        </div>
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
