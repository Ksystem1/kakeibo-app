import { useCallback, useState } from "react";
import {
  createTransaction,
  getApiBaseUrl,
  getCategories,
  getHealth,
  getTransactions,
} from "../lib/api";
import styles from "./DevApiTest.module.css";

type TxRow = {
  id: number;
  kind: string;
  amount: string;
  transaction_date: string;
  memo: string | null;
};

function todayUtcDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function DevApiTest() {
  const base = getApiBaseUrl();
  const devUser = import.meta.env.VITE_DEV_USER_ID ?? "";
  const [log, setLog] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<TxRow[]>([]);

  const appendLog = useCallback((msg: string) => {
    setLog((prev) => (prev ? `${prev}\n${msg}` : msg));
  }, []);

  const run = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      setError(null);
      setBusy(true);
      appendLog(`→ ${label} …`);
      try {
        const out = await fn();
        appendLog(`  OK: ${JSON.stringify(out)}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        appendLog(`  失敗: ${msg}`);
        setError(msg);
      } finally {
        setBusy(false);
      }
    },
    [appendLog],
  );

  const onHealth = () => run("GET /health", () => getHealth());

  const onListTx = () =>
    run("GET /transactions", async () => {
      const r = await getTransactions();
      setRows((r.items ?? []) as TxRow[]);
      return { count: r.items?.length ?? 0 };
    });

  const onListCategories = () =>
    run("GET /categories", () => getCategories());

  const onSeedTx = () =>
    run("POST /transactions（テスト1件）", async () => {
      const body = {
        kind: "expense",
        amount: 1500,
        transaction_date: todayUtcDate(),
        memo: "ローカルAPIテスト（フロントから投入）",
      };
      const created = await createTransaction(body);
      const r = await getTransactions();
      setRows((r.items ?? []) as TxRow[]);
      return { createdId: created.id, listed: r.items?.length ?? 0 };
    });

  const missingBase = !base;

  return (
    <div className={styles.wrap}>
      <h1 className={styles.title}>API・DB 接続テスト</h1>
      <p className={styles.lead}>
        バックエンドで <code>npm run dev:api</code> を起動した状態で操作してください。
        開発ユーザーが未作成なら <code>backend</code> で{" "}
        <code>npm run db:dev-user</code> を実行し、表示された{" "}
        <code>VITE_DEV_USER_ID</code> をフロントの <code>.env</code> に合わせます。
      </p>

      <div className={styles.config}>
        <div>
          <strong>VITE_API_URL</strong>{" "}
          {base || "（未設定 — プロジェクト直下 .env を確認）"}
        </div>
        <div>
          <strong>VITE_DEV_USER_ID</strong> {devUser || "（未設定）"}
        </div>
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.btn}
          disabled={busy || missingBase}
          onClick={onHealth}
        >
          ヘルス確認
        </button>
        <button
          type="button"
          className={styles.btn}
          disabled={busy || missingBase}
          onClick={onListCategories}
        >
          カテゴリ取得
        </button>
        <button
          type="button"
          className={styles.btn}
          disabled={busy || missingBase}
          onClick={onListTx}
        >
          取引一覧
        </button>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          disabled={busy || missingBase || !devUser}
          onClick={onSeedTx}
        >
          テスト取引を1件追加
        </button>
      </div>

      {error ? (
        <p className={styles.err} role="alert">
          {error}
        </p>
      ) : null}

      <div className={styles.listTitle}>ログ</div>
      <div className={styles.log}>{log || "（まだありません）"}</div>

      <div className={styles.listTitle}>取引（右のボタンで再取得）</div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>id</th>
              <th>日付</th>
              <th>種別</th>
              <th>金額</th>
              <th>メモ</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ color: "var(--text-muted)" }}>
                  データがありません。「取引一覧」または「テスト取引を追加」で表示します。
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.id}</td>
                  <td>{r.transaction_date}</td>
                  <td>{r.kind}</td>
                  <td>{r.amount}</td>
                  <td>{r.memo ?? ""}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
