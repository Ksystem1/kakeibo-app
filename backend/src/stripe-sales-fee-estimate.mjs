/**
 * Stripe テスト等で手数料が 0 や欠落しているとき用のフォールバック（既定 3.6% ・四捨五入・円は整数）。
 * 本番で BT に fee がある行は従来どおり上書きしない。
 */

const DEFAULT_RATE = 0.036;

const ZERO_DECIMAL_CURRENCIES = new Set([
  "bif",
  "clp",
  "djf",
  "gnf",
  "jpy",
  "kmf",
  "krw",
  "mga",
  "pyg",
  "rwf",
  "ugx",
  "vnd",
  "vuv",
  "xaf",
  "xof",
  "xpf",
]);

/**
 * @param {object} p
 * @param {number} p.gross
 * @param {number} p.fee
 * @param {number|null|undefined} p.net
 * @param {string} [p.currency]
 * @param {number} [p.rate] 既定 0.036
 * @returns {{ gross: number; fee: number; net: number; feeWasEstimated: boolean }}
 */
export function applyEstimatedFeeIfZero(p) {
  const rate = p.rate != null && Number.isFinite(p.rate) ? p.rate : DEFAULT_RATE;
  const ccy = String(p.currency || "jpy")
    .trim()
    .toLowerCase();
  const g = Number(p.gross);
  const f0 = Number(p.fee ?? 0);
  const n0 = p.net == null || p.net === "" ? null : Number(p.net);

  if (!Number.isFinite(g)) {
    return { gross: 0, fee: 0, net: 0, feeWasEstimated: false };
  }
  if (g <= 0) {
    return { gross: g, fee: f0, net: n0 != null && Number.isFinite(n0) ? n0 : g - f0, feeWasEstimated: false };
  }
  if (Number.isFinite(f0) && Math.abs(f0) >= 0.01) {
    const n = n0 != null && Number.isFinite(n0) ? n0 : g - f0;
    return { gross: g, fee: f0, net: n, feeWasEstimated: false };
  }

  const impliedFromNet = n0 != null && Number.isFinite(n0) ? g - n0 : null;
  if (impliedFromNet != null && impliedFromNet > 0.01 && impliedFromNet < g * 0.5) {
    return { gross: g, fee: impliedFromNet, net: n0, feeWasEstimated: false };
  }

  const estFee =
    ccy === "jpy" || ZERO_DECIMAL_CURRENCIES.has(ccy) ? Math.round(g * rate) : Math.round(g * rate * 100) / 100;
  const estNet = g - estFee;
  return { gross: g, fee: estFee, net: estNet, feeWasEstimated: true };
}

export function applyEstimatedFeeToLogRowForDisplay(row) {
  if (!row || typeof row !== "object") return row;
  const adj = applyEstimatedFeeIfZero({
    gross: Number(row.gross_amount),
    fee: Number(row.stripe_fee_amount),
    net: row.net_amount != null ? Number(row.net_amount) : null,
    currency: row.currency,
  });
  return {
    ...row,
    gross_amount: adj.gross,
    stripe_fee_amount: adj.fee,
    net_amount: adj.net,
  };
}
