const KEY = "kakeibo_debug_receipt_tier";

export type ReceiptDebugTier = "server" | "free" | "subscribed";

export function getReceiptDebugTier(): ReceiptDebugTier {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "free" || v === "subscribed") return v;
  } catch {
    /* ignore */
  }
  return "server";
}

export function setReceiptDebugTier(t: ReceiptDebugTier) {
  try {
    if (t === "server") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event("kakeibo-receipt-debug-tier"));
}
