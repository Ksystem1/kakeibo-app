import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import {
  createChildSession,
  getChildProfiles,
  normalizeAuthContextUser,
  type GradeGroup,
} from "../lib/api";
import styles from "../components/LoginScreen.module.css";

function gradeLabel(v: GradeGroup | null | undefined) {
  if (v === "1-2") return "1-2年生";
  if (v === "3-4") return "3-4年生";
  if (v === "5-6") return "5-6年生";
  return "学年未設定";
}

export function ChildProfileSelectPage() {
  const navigate = useNavigate();
  const { token, setSession } = useAuth();
  const [items, setItems] = useState<
    Array<{ id: number; display_name: string | null; grade_group: GradeGroup | null }>
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!token) {
      navigate("/login", { replace: true });
      return;
    }
    void getChildProfiles()
      .then((res) => {
        const list = Array.isArray(res.items) ? res.items : [];
        if (list.length === 0) {
          navigate("/", { replace: true });
          return;
        }
        setItems(list);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [navigate, token]);

  async function switchToChild(childId: number) {
    setLoading(true);
    setError(null);
    try {
      const res = await createChildSession(childId);
      setSession(res.token, normalizeAuthContextUser(res.user));
      navigate("/", { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.page}>
      <main className={styles.panel}>
        <div className={styles.card}>
          <header className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>子供プロフィールを選んでください</h2>
            <p className={styles.cardSub}>親ログイン後に利用する子供アカウントを選択します。</p>
          </header>
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
          <div className={styles.form}>
            {items.map((c) => (
              <button
                key={c.id}
                type="button"
                className={styles.submit}
                disabled={loading}
                onClick={() => void switchToChild(c.id)}
              >
                {(c.display_name ?? `子供${c.id}`) + `（${gradeLabel(c.grade_group)}）`}
              </button>
            ))}
            <button
              type="button"
              className={styles.link}
              onClick={() => navigate("/", { replace: true })}
              disabled={loading}
            >
              親アカウントのまま続ける
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
