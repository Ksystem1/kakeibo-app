import { FormEvent, useCallback, useEffect, useState } from "react";
import { createChildProfile, getChildProfiles, getFamilyMembers, type GradeGroup } from "../lib/api";
import styles from "../components/KakeiboDashboard.module.css";

export function MembersPage({ embedded = false }: { embedded?: boolean }) {
  const [items, setItems] = useState<
    Array<{
      id: number;
      email: string;
      display_name: string | null;
      role: string;
    }>
  >([]);
  const [childName, setChildName] = useState("");
  const [gradeGroup, setGradeGroup] = useState<GradeGroup>("1-2");
  const [children, setChildren] = useState<
    Array<{
      id: number;
      display_name: string | null;
      grade_group: GradeGroup | null;
    }>
  >([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await getFamilyMembers();
      setItems(r.items ?? []);
      const kids = await getChildProfiles();
      setChildren(kids.items ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onCreateChild(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    setErr(null);
    setLoading(true);
    try {
      await createChildProfile({
        display_name: childName.trim(),
        grade_group: gradeGroup,
      });
      setMsg("子供プロフィールを追加しました。");
      setChildName("");
      await load();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setLoading(false);
    }
  }

  const content = (
    <>
      {err ? (
        <p className={styles.err} role="alert">
          {err}
        </p>
      ) : null}
      {msg ? <p style={{ color: "var(--accent)" }}>{msg}</p> : null}

      <h2 className={styles.sectionTitle}>メンバー一覧</h2>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>メール</th>
              <th>表示名</th>
              <th>権限</th>
            </tr>
          </thead>
          <tbody>
            {items.map((m) => (
              <tr key={m.id}>
                <td>{m.email}</td>
                <td>{m.display_name ?? "—"}</td>
                <td>{m.role === "owner" ? "オーナー" : "メンバー"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className={styles.sectionTitle}>子供プロフィール</h2>
      <div className={styles.tableWrap} style={{ marginBottom: "0.75rem" }}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>名前</th>
              <th>学年グループ</th>
            </tr>
          </thead>
          <tbody>
            {children.length === 0 ? (
              <tr>
                <td colSpan={2}>まだ子供プロフィールがありません</td>
              </tr>
            ) : (
              children.map((c) => (
                <tr key={c.id}>
                  <td>{c.display_name ?? `子供${c.id}`}</td>
                  <td>{c.grade_group === "1-2" ? "1-2年生" : c.grade_group === "3-4" ? "3-4年生" : "5-6年生"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <h2 className={styles.sectionTitle}>子供を追加</h2>
      <form
        onSubmit={onCreateChild}
        style={{ display: "grid", gap: "0.5rem" }}
      >
        <input
          type="text"
          value={childName}
          onChange={(e) => setChildName(e.target.value)}
          placeholder="名前"
          className={styles.monthInput}
        />
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.6rem" }}>
          <label><input type="radio" name="grade-group" value="1-2" checked={gradeGroup === "1-2"} onChange={() => setGradeGroup("1-2")} /> 1-2年生</label>
          <label><input type="radio" name="grade-group" value="3-4" checked={gradeGroup === "3-4"} onChange={() => setGradeGroup("3-4")} /> 3-4年生</label>
          <label><input type="radio" name="grade-group" value="5-6" checked={gradeGroup === "5-6"} onChange={() => setGradeGroup("5-6")} /> 5-6年生</label>
        </div>
        <button
          type="submit"
          className={`${styles.btn} ${styles.btnPrimary}`}
          disabled={loading}
        >
          子供を追加
        </button>
      </form>
    </>
  );

  if (embedded) return content;

  return (
    <div className={styles.wrap}>
      <h1 className={styles.title}>家族・利用ユーザー</h1>
      <p className={styles.sub}>
        親アカウントに子供プロフィールを追加できます。メール招待は使いません。
      </p>
      {content}
    </div>
  );
}
