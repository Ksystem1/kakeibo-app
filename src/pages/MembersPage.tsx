import { FormEvent, useCallback, useEffect, useState } from "react";
import QRCode from "react-qr-code";
import {
  createChildProfile,
  deleteChildProfile,
  getChildProfiles,
  getFamilyMembers,
  issueFamilyInviteLink,
  updateChildProfile,
  type GradeGroup,
} from "../lib/api";
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
  const [editingChildId, setEditingChildId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editGradeGroup, setEditGradeGroup] = useState<GradeGroup>("1-2");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

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

  async function onIssueInviteLink(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    setErr(null);
    setLoading(true);
    try {
      const r = await issueFamilyInviteLink();
      const url = r.invite_url ?? null;
      setInviteUrl(url);
      setMsg(r.message ?? "招待URLを発行しました。URLまたはQRで共有できます。");
      await load();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setLoading(false);
    }
  }

  function beginEditChild(childId: number, name: string | null, gg: GradeGroup | null) {
    setEditingChildId(childId);
    setEditName((name ?? "").trim());
    setEditGradeGroup(gg ?? "1-2");
  }

  function cancelEditChild() {
    setEditingChildId(null);
    setEditName("");
    setEditGradeGroup("1-2");
  }

  async function onSaveChildProfile(childId: number) {
    setMsg(null);
    setErr(null);
    setLoading(true);
    try {
      await updateChildProfile(childId, {
        display_name: editName.trim(),
        grade_group: editGradeGroup,
      });
      setMsg("子供プロフィールを更新しました。");
      cancelEditChild();
      await load();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setLoading(false);
    }
  }

  async function onDeleteChildProfile(childId: number) {
    if (!window.confirm("本当に削除しますか？")) return;
    setMsg(null);
    setErr(null);
    setLoading(true);
    try {
      await deleteChildProfile(childId);
      setMsg("子供プロフィールを削除しました。");
      if (editingChildId === childId) cancelEditChild();
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
      <div className={`${styles.tableWrap} ${styles.membersTableWrap}`}>
        <table className={`${styles.table} ${styles.membersTable}`}>
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
      <div
        className={`${styles.tableWrap} ${styles.childProfileTableWrap}`}
        style={{ marginBottom: "0.75rem" }}
      >
        <table className={`${styles.table} ${styles.childProfileTable}`}>
          <thead>
            <tr>
              <th>名前</th>
              <th>学年グループ</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {children.length === 0 ? (
              <tr>
                <td colSpan={3}>まだ子供プロフィールがありません</td>
              </tr>
            ) : (
              children.map((c) => (
                <tr key={c.id}>
                  <td>
                    {editingChildId === c.id ? (
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className={styles.monthInput}
                        style={{ minWidth: 160 }}
                      />
                    ) : (
                      c.display_name ?? `子供${c.id}`
                    )}
                  </td>
                  <td>
                    {editingChildId === c.id ? (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                        <label><input type="radio" name={`edit-grade-${c.id}`} checked={editGradeGroup === "1-2"} onChange={() => setEditGradeGroup("1-2")} /> 1-2年生</label>
                        <label><input type="radio" name={`edit-grade-${c.id}`} checked={editGradeGroup === "3-4"} onChange={() => setEditGradeGroup("3-4")} /> 3-4年生</label>
                        <label><input type="radio" name={`edit-grade-${c.id}`} checked={editGradeGroup === "5-6"} onChange={() => setEditGradeGroup("5-6")} /> 5-6年生</label>
                      </div>
                    ) : c.grade_group === "1-2" ? (
                      "1-2年生"
                    ) : c.grade_group === "3-4" ? (
                      "3-4年生"
                    ) : (
                      "5-6年生"
                    )}
                  </td>
                  <td>
                    {editingChildId === c.id ? (
                      <div className={styles.childProfileActions}>
                        <button
                          type="button"
                          className={`${styles.btn} ${styles.btnSm} ${styles.btnPrimary}`}
                          disabled={loading}
                          onClick={() => void onSaveChildProfile(c.id)}
                        >
                          保存
                        </button>
                        <button
                          type="button"
                          className={`${styles.btn} ${styles.btnSm}`}
                          disabled={loading}
                          onClick={cancelEditChild}
                        >
                          キャンセル
                        </button>
                      </div>
                    ) : (
                      <div className={styles.childProfileActions}>
                        <button
                          type="button"
                          className={`${styles.btn} ${styles.btnSm}`}
                          disabled={loading}
                          onClick={() => beginEditChild(c.id, c.display_name, c.grade_group)}
                        >
                          編集
                        </button>
                        <button
                          type="button"
                          className={`${styles.btn} ${styles.btnSm}`}
                          disabled={loading}
                          onClick={() => void onDeleteChildProfile(c.id)}
                        >
                          削除
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <h2 className={styles.sectionTitle}>大人メンバーを招待（URL / QR）</h2>
      <p style={{ margin: "0 0 0.4rem", color: "var(--muted, #5c6670)" }}>
        相手のメール入力は不要です。発行したURLを送り、相手が自身のメール＋パスワードで登録すると同じ家族に入ります。
      </p>
      <form onSubmit={onIssueInviteLink} style={{ display: "grid", gap: "0.5rem" }}>
        <button
          type="submit"
          className={`${styles.btn} ${styles.btnPrimary}`}
          disabled={loading}
        >
          招待URLを発行
        </button>
      </form>
      {inviteUrl ? (
        <div
          className={styles.settingsPanel}
          style={{
            marginTop: "0.6rem",
            padding: "0.75rem",
            border: "1px solid var(--border)",
          }}
        >
          <p style={{ margin: "0 0 0.45rem", fontWeight: 600 }}>招待URL（大人向け）</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.6rem", alignItems: "center" }}>
            <a href={inviteUrl} target="_blank" rel="noreferrer" className={styles.btn}>
              招待URLを開く
            </a>
            <button
              type="button"
              className={styles.btn}
              onClick={async () => {
                await navigator.clipboard.writeText(inviteUrl);
                setMsg("招待URLをコピーしました。");
              }}
            >
              URLをコピー
            </button>
            <div style={{ padding: 6, borderRadius: 8, background: "#fff", lineHeight: 0 }}>
              <QRCode value={inviteUrl} size={96} level="M" fgColor="#0f1419" bgColor="#ffffff" />
            </div>
          </div>
        </div>
      ) : null}

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
        親アカウントに子供プロフィールを追加できます。家族招待はURL共有で行います。
      </p>
      {content}
    </div>
  );
}
