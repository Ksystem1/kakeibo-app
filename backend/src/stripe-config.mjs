/**
 * Stripe キー解決
 * - 既定: STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET（テストなら sk_test_ / whsec_ をここに設定可能）
 * - フォールバック: STRIPE_TEST_SECRET_KEY / STRIPE_TEST_WEBHOOK_SECRET（別名で分けたい場合）
 */

export function getStripeWebhookSecret() {
  const primary = String(process.env.STRIPE_WEBHOOK_SECRET ?? "").trim();
  if (primary) return primary;
  return String(process.env.STRIPE_TEST_WEBHOOK_SECRET ?? "").trim();
}

export function getStripeSecretKey() {
  const primary = String(process.env.STRIPE_SECRET_KEY ?? "").trim();
  if (primary) return primary;
  return String(process.env.STRIPE_TEST_SECRET_KEY ?? "").trim();
}

export function requireStripeSecretKey() {
  const k = getStripeSecretKey();
  if (!k) {
    throw new Error(
      "STRIPE_SECRET_KEY または STRIPE_TEST_SECRET_KEY を設定してください",
    );
  }
  return k;
}
