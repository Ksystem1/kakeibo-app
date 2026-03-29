/**
 * 広告枠（将来の広告収入用）。VITE_ADS_ENABLED=true のとき表示。
 */
export function AdSlot({ placement }: { placement: string }) {
  const on = import.meta.env.VITE_ADS_ENABLED === "true";
  if (!on) return null;
  return (
    <aside
      className="ad-slot"
      data-placement={placement}
      style={{
        margin: "1rem auto",
        maxWidth: 728,
        minHeight: 90,
        border: "1px dashed rgba(255,255,255,0.2)",
        borderRadius: 12,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--text-muted)",
        fontSize: "0.8rem",
      }}
    >
      広告枠（{placement}）— 配信SDK接続予定
    </aside>
  );
}
