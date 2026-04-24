import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { DragEvent } from "react";
import {
  createCategory,
  deleteCategory,
  getCategories,
  type MedicalType,
  updateCategory,
  type CategoryItem,
} from "../lib/api";
import { useIsMobile } from "../hooks/useIsMobile";
import styles from "../components/KakeiboDashboard.module.css";
import catStyles from "./CategoriesPage.module.css";

type CategoryDraft = {
  name: string;
  kind: "expense" | "income";
  color_hex: string;
  sort_order: string;
  is_medical_default: boolean;
  default_medical_type: MedicalType | "";
  default_patient_name: string;
};

function sortCategories(items: CategoryItem[]) {
  return [...items].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    return a.id - b.id;
  });
}

export function CategoriesPage({ embedded = false }: { embedded?: boolean }) {
  const mobile = useIsMobile();
  const [items, setItems] = useState<CategoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<"expense" | "income">("expense");
  const [newColor, setNewColor] = useState("#94a3b8");
  const [newMedicalDefault, setNewMedicalDefault] = useState(false);
  const [newMedicalType, setNewMedicalType] = useState<MedicalType | "">("");
  const [newMedicalPatientName, setNewMedicalPatientName] = useState("");
  const [savingId, setSavingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getCategories();
      setItems(Array.isArray(res.items) ? res.items : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "カテゴリの取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const expenseRows = useMemo(
    () => sortCategories(items.filter((c) => c.kind === "expense")),
    [items],
  );
  const incomeRows = useMemo(
    () => sortCategories(items.filter((c) => c.kind === "income")),
    [items],
  );

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) {
      setError("カテゴリ名を入力してください。");
      return;
    }
    if (newMedicalDefault && !newMedicalType) {
      setError("医療費控除の対象にする場合は区分を選択してください。");
      return;
    }
    setError(null);
    try {
      await createCategory({
        name,
        kind: newKind,
        color_hex: newColor || null,
        sort_order: 0,
        is_medical_default: newKind === "expense" && newMedicalDefault,
        default_medical_type:
          newKind === "expense" && newMedicalDefault ? newMedicalType || null : null,
        default_patient_name:
          newKind === "expense" && newMedicalDefault ? newMedicalPatientName.trim() || null : null,
      });
      setNewName("");
      setNewMedicalDefault(false);
      setNewMedicalType("");
      setNewMedicalPatientName("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "追加に失敗しました");
    }
  }

  async function onSaveRow(c: CategoryItem, draft: CategoryDraft) {
    const name = draft.name.trim();
    if (!name || name.length > 100) {
      setError("カテゴリ名は1〜100文字で入力してください。");
      return;
    }
    const so = Number.parseInt(draft.sort_order, 10);
    if (!Number.isFinite(so)) {
      setError("並び順は整数で入力してください。");
      return;
    }
    const ch = draft.color_hex.trim();
    if (ch && !/^#[0-9A-Fa-f]{6}$/.test(ch)) {
      setError("色は #RRGGBB 形式で入力してください。");
      return;
    }
    if (draft.is_medical_default && !draft.default_medical_type) {
      setError("医療費控除の対象にする場合は区分を選択してください。");
      return;
    }
    setSavingId(c.id);
    setError(null);
    try {
      await updateCategory(c.id, {
        name,
        kind: draft.kind,
        color_hex: ch || null,
        sort_order: so,
        is_medical_default: draft.kind === "expense" && draft.is_medical_default,
        default_medical_type:
          draft.kind === "expense" && draft.is_medical_default
            ? draft.default_medical_type || null
            : null,
        default_patient_name:
          draft.kind === "expense" && draft.is_medical_default
            ? draft.default_patient_name.trim() || null
            : null,
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新に失敗しました");
    } finally {
      setSavingId(null);
    }
  }

  async function onRemove(c: CategoryItem) {
    if (!window.confirm(`「${c.name}」を削除しますか？（取引の紐付けは残ります）`)) return;
    setSavingId(c.id);
    setError(null);
    try {
      await deleteCategory(c.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "削除に失敗しました");
    } finally {
      setSavingId(null);
    }
  }

  const content = (
    <>
      {error ? (
        <p className={styles.infoText} style={{ color: "#fecaca" }}>
          {error}
        </p>
      ) : null}

      <form
        className={styles.settingsPanel}
        style={{ maxWidth: 520, marginBottom: "1.25rem" }}
        onSubmit={onAdd}
      >
        <h2 className={styles.sectionTitle}>カテゴリを追加</h2>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center" }}>
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="例: 外食"
            maxLength={100}
            className={styles.monthInput}
            style={{ flex: "1 1 160px", minWidth: 140 }}
            disabled={loading}
          />
          <select
            value={newKind}
            onChange={(e) =>
              setNewKind(e.target.value === "income" ? "income" : "expense")
            }
            className={styles.monthInput}
            disabled={loading}
          >
            <option value="expense">支出</option>
            <option value="income">収入</option>
          </select>
          <input
            type="color"
            value={newColor}
            onChange={(e) => setNewColor(e.target.value)}
            title="色"
            disabled={loading}
            style={{ width: 44, height: 36, padding: 2, border: "none", borderRadius: 6 }}
          />
          <button
            type="submit"
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={loading}
          >
            追加
          </button>
        </div>
        <div style={{ marginTop: "0.6rem", display: "grid", gap: "0.45rem" }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
            <input
              type="checkbox"
              checked={newMedicalDefault}
              onChange={(e) => setNewMedicalDefault(e.target.checked)}
              disabled={loading || newKind !== "expense"}
            />
            このカテゴリを医療費控除の既定にする
          </label>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <select
              className={styles.monthInput}
              value={newMedicalType}
              onChange={(e) => setNewMedicalType((e.target.value as MedicalType | "") ?? "")}
              disabled={!newMedicalDefault || newKind !== "expense" || loading}
            >
              <option value="">3区分を選択</option>
              <option value="treatment">診療・治療</option>
              <option value="medicine">医薬品</option>
              <option value="other">その他</option>
            </select>
            <input
              type="text"
              className={styles.monthInput}
              value={newMedicalPatientName}
              onChange={(e) => setNewMedicalPatientName(e.target.value)}
              placeholder="既定の対象者（例: 子ども）"
              maxLength={120}
              disabled={!newMedicalDefault || newKind !== "expense" || loading}
              style={{ minWidth: 190 }}
            />
          </div>
        </div>
      </form>

      {loading ? (
        <p className={styles.sub}>読み込み中...</p>
      ) : (
        <>
          <CategoryTable
            title="支出"
            rows={expenseRows}
            savingId={savingId}
            allowReorder={!mobile}
            onSave={onSaveRow}
            onRemove={onRemove}
            onReload={load}
            onReorderError={(msg) => setError(msg)}
          />
          <CategoryTable
            title="収入"
            rows={incomeRows}
            savingId={savingId}
            allowReorder={!mobile}
            onSave={onSaveRow}
            onRemove={onRemove}
            onReload={load}
            onReorderError={(msg) => setError(msg)}
          />
        </>
      )}

      <p className={styles.sub} style={{ marginTop: "1rem" }}>
        <button type="button" className={styles.btn} onClick={() => void load()} disabled={loading}>
          再読み込み
        </button>
      </p>
    </>
  );

  if (embedded) return content;

  return (
    <div className={styles.wrap}>
      <h1 className={styles.title}>カテゴリ</h1>
      <p className={styles.sub}>
        支出・収入のカテゴリを追加・変更・削除できます。初回アクセス時や新規登録時に、よく使うカテゴリが自動で用意されます。
      </p>
      {content}
    </div>
  );
}

const DND_TYPE = "application/x-kakeibo-category-id";

function CategoryTable({
  title,
  rows,
  savingId,
  allowReorder,
  onSave,
  onRemove,
  onReload,
  onReorderError,
}: {
  title: string;
  rows: CategoryItem[];
  savingId: number | null;
  allowReorder: boolean;
  onSave: (
    c: CategoryItem,
    draft: {
      name: string;
      kind: "expense" | "income";
      color_hex: string;
      sort_order: string;
      is_medical_default: boolean;
      default_medical_type: MedicalType | "";
      default_patient_name: string;
    },
  ) => void;
  onRemove: (c: CategoryItem) => void;
  onReload: () => Promise<void>;
  onReorderError: (msg: string | null) => void;
}) {
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [localOrder, setLocalOrder] = useState<number[] | null>(null);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [dropTargetId, setDropTargetId] = useState<number | null>(null);
  const [reordering, setReordering] = useState(false);

  const rowIdsKey = rows.map((r) => r.id).join(",");
  useEffect(() => {
    setLocalOrder(null);
  }, [rowIdsKey]);

  const displayRows = useMemo(() => {
    if (localOrder) {
      const m = new Map(rows.map((r) => [r.id, r]));
      return localOrder.map((id) => m.get(id)).filter(Boolean) as CategoryItem[];
    }
    const list = [...rows];
    if (sortDir === "asc") {
      list.sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
    } else {
      list.sort((a, b) => b.sort_order - a.sort_order || a.id - b.id);
    }
    return list;
  }, [rows, localOrder, sortDir]);

  async function persistOrder(orderedIds: number[]) {
    setReordering(true);
    onReorderError(null);
    try {
      const step = 10;
      for (let i = 0; i < orderedIds.length; i++) {
        await updateCategory(orderedIds[i], { sort_order: (i + 1) * step });
      }
      setLocalOrder(null);
      await onReload();
    } catch (e) {
      setLocalOrder(null);
      onReorderError(
        e instanceof Error ? e.message : "並び替えの保存に失敗しました",
      );
    } finally {
      setReordering(false);
    }
  }

  function reorderIds(dragId: number, dropId: number) {
    const base = localOrder ?? rows.map((r) => r.id);
    const i = base.indexOf(dragId);
    const j = base.indexOf(dropId);
    if (i < 0 || j < 0 || dragId === dropId) return;
    const next = [...base];
    next.splice(i, 1);
    next.splice(j, 0, dragId);
    setLocalOrder(next);
    void persistOrder(next);
  }

  function handleDragStart(e: DragEvent, id: number) {
    e.dataTransfer.setData(DND_TYPE, String(id));
    e.dataTransfer.effectAllowed = "move";
    setDraggingId(id);
    setDropTargetId(null);
  }

  function handleDragEnd() {
    setDraggingId(null);
    setDropTargetId(null);
  }

  function handleDragOver(e: DragEvent, id: number) {
    if (draggingId == null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropTargetId(id);
  }

  function handleDrop(e: DragEvent, dropId: number) {
    e.preventDefault();
    const raw = e.dataTransfer.getData(DND_TYPE);
    const dragId = Number.parseInt(raw, 10);
    setDropTargetId(null);
    setDraggingId(null);
    if (!Number.isFinite(dragId) || dragId === dropId) return;
    reorderIds(dragId, dropId);
  }

  return (
    <div className={styles.settingsPanel} style={{ maxWidth: 900, marginBottom: "1rem" }}>
      <h2 className={styles.sectionTitle}>{title}</h2>
      {allowReorder ? (
        <p className={catStyles.hint}>
          左の「⠿」をドラッグして並べ替えると、並び順の番号が自動で保存されます。「並び」の↑↓で、番号に応じた表示順を切り替えられます。
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p className={styles.sub}>カテゴリがありません。</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className={catStyles.table}>
            <thead>
              <tr>
                {allowReorder ? (
                  <th className={catStyles.th} style={{ width: "2.5rem" }} aria-label="並べ替え" />
                ) : null}
                <th className={catStyles.th}>名前</th>
                <th className={catStyles.th}>種別</th>
                <th className={catStyles.th}>色</th>
                <th className={catStyles.th}>
                  <button
                    type="button"
                    className={catStyles.sortHeader}
                    onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
                    title="並び順の番号で表示を切り替え"
                  >
                    並び {sortDir === "asc" ? "↑" : "↓"}
                  </button>
                </th>
                <th className={catStyles.th}>医療費控除の既定</th>
                <th className={catStyles.th} />
              </tr>
            </thead>
            <tbody>
              {displayRows.map((c) => (
                <CategoryRow
                  key={c.id}
                  c={c}
                  disabled={reordering || savingId === c.id}
                  allowReorder={allowReorder}
                  dragOver={dropTargetId === c.id && draggingId != null && draggingId !== c.id}
                  onDragStartHandle={(e) => handleDragStart(e, c.id)}
                  onDragEndHandle={handleDragEnd}
                  onRowDragOver={(e) => handleDragOver(e, c.id)}
                  onRowDrop={(e) => handleDrop(e, c.id)}
                  onRowDragLeave={() => setDropTargetId(null)}
                  onSave={onSave}
                  onRemove={onRemove}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CategoryRow({
  c,
  disabled,
  allowReorder,
  dragOver,
  onDragStartHandle,
  onDragEndHandle,
  onRowDragOver,
  onRowDrop,
  onRowDragLeave,
  onSave,
  onRemove,
}: {
  c: CategoryItem;
  disabled: boolean;
  allowReorder: boolean;
  dragOver: boolean;
  onDragStartHandle: (e: DragEvent) => void;
  onDragEndHandle: () => void;
  onRowDragOver: (e: DragEvent) => void;
  onRowDrop: (e: DragEvent) => void;
  onRowDragLeave: () => void;
  onSave: (c: CategoryItem, draft: CategoryDraft) => void;
  onRemove: (c: CategoryItem) => void;
}) {
  const [name, setName] = useState(c.name);
  const [kind, setKind] = useState<"expense" | "income">(
    c.kind === "income" ? "income" : "expense",
  );
  const [colorHex, setColorHex] = useState(c.color_hex || "#94a3b8");
  const [sortOrder, setSortOrder] = useState(String(c.sort_order));
  const [isMedicalDefault, setIsMedicalDefault] = useState(
    c.is_medical_default === true || Number(c.is_medical_default) === 1,
  );
  const [defaultMedicalType, setDefaultMedicalType] = useState<MedicalType | "">(
    c.default_medical_type ?? "",
  );
  const [defaultPatientName, setDefaultPatientName] = useState(c.default_patient_name ?? "");

  useEffect(() => {
    setName(c.name);
    setKind(c.kind === "income" ? "income" : "expense");
    setColorHex(c.color_hex || "#94a3b8");
    setSortOrder(String(c.sort_order));
    setIsMedicalDefault(c.is_medical_default === true || Number(c.is_medical_default) === 1);
    setDefaultMedicalType(c.default_medical_type ?? "");
    setDefaultPatientName(c.default_patient_name ?? "");
  }, [
    c.id,
    c.name,
    c.kind,
    c.color_hex,
    c.sort_order,
    c.is_medical_default,
    c.default_medical_type,
    c.default_patient_name,
  ]);

  const trClass = dragOver ? catStyles.dragOver : undefined;

  return (
    <tr
      className={trClass}
      style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }}
      onDragOver={allowReorder ? onRowDragOver : undefined}
      onDrop={allowReorder ? onRowDrop : undefined}
      onDragLeave={allowReorder ? onRowDragLeave : undefined}
    >
      {allowReorder ? (
        <td
          className={catStyles.dragHandleCell}
          draggable
          onDragStart={onDragStartHandle}
          onDragEnd={onDragEndHandle}
          title="ドラッグして並べ替え"
          aria-grabbed="false"
        >
          ⠿
        </td>
      ) : null}
      <td style={{ padding: "0.4rem 0.35rem", verticalAlign: "middle" }}>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
          className={styles.monthInput}
          style={{ width: "100%", minWidth: 120 }}
          disabled={disabled}
        />
      </td>
      <td style={{ padding: "0.4rem 0.35rem", verticalAlign: "middle" }}>
        <select
          value={kind}
          onChange={(e) =>
            setKind(e.target.value === "income" ? "income" : "expense")
          }
          className={styles.monthInput}
          disabled={disabled}
        >
          <option value="expense">支出</option>
          <option value="income">収入</option>
        </select>
      </td>
      <td style={{ padding: "0.4rem 0.35rem", verticalAlign: "middle" }}>
        <input
          type="color"
          value={colorHex}
          onChange={(e) => setColorHex(e.target.value)}
          disabled={disabled}
          style={{ width: 40, height: 32, padding: 0, border: "none" }}
        />
      </td>
      <td style={{ padding: "0.4rem 0.35rem", verticalAlign: "middle" }}>
        <input
          type="number"
          value={sortOrder}
          onChange={(e) => setSortOrder(e.target.value)}
          className={styles.monthInput}
          style={{ width: 72 }}
          disabled={disabled}
        />
      </td>
      <td style={{ padding: "0.4rem 0.35rem", verticalAlign: "middle", minWidth: 210 }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
          <input
            type="checkbox"
            checked={isMedicalDefault}
            onChange={(e) => setIsMedicalDefault(e.target.checked)}
            disabled={disabled || kind !== "expense"}
          />
          対象
        </label>
        <select
          className={styles.monthInput}
          value={defaultMedicalType}
          onChange={(e) => setDefaultMedicalType((e.target.value as MedicalType | "") ?? "")}
          disabled={disabled || !isMedicalDefault || kind !== "expense"}
          style={{ width: "100%", marginBottom: 4 }}
        >
          <option value="">3区分を選択</option>
          <option value="treatment">診療・治療</option>
          <option value="medicine">医薬品</option>
          <option value="other">その他</option>
        </select>
        <input
          type="text"
          value={defaultPatientName}
          onChange={(e) => setDefaultPatientName(e.target.value)}
          maxLength={120}
          placeholder="対象者名"
          className={styles.monthInput}
          disabled={disabled || !isMedicalDefault || kind !== "expense"}
          style={{ width: "100%" }}
        />
      </td>
      <td style={{ padding: "0.4rem 0.35rem", whiteSpace: "nowrap", verticalAlign: "middle" }}>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          disabled={disabled}
          onClick={() =>
            void onSave(c, {
              name,
              kind,
              color_hex: colorHex,
              sort_order: sortOrder,
              is_medical_default: isMedicalDefault,
              default_medical_type: defaultMedicalType,
              default_patient_name: defaultPatientName,
            })
          }
        >
          保存
        </button>{" "}
        <button
          type="button"
          className={styles.btn}
          disabled={disabled}
          onClick={() => onRemove(c)}
          style={{ color: "#fecaca" }}
        >
          削除
        </button>
      </td>
    </tr>
  );
}
