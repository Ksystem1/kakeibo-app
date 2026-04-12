/**
 * Stripe キー解決（Test mode 優先。未設定時は従来の STRIPE_* にフォールバック）
 */

export function getStripeWebhookSecret() {
  const test = String(process.env.STRIPE_TEST_WEBHOOK_SECRET ?? "").trim();
  if (test) return test;
  return String(process.env.STRIPE_WEBHOOK_SECRET ?? "").trim();
}

export function getStripeSecretKey() {
  const test = String(process.env.STRIPE_TEST_SECRET_KEY ?? "").trim();
  if (test) return test;
  return String(process.env.STRIPE_SECRET_KEY ?? "").trim();
}

export function requireStripeSecretKey() {
  const k = getStripeSecretKey();
  if (!k) {
    throw new Error(
      "STRIPE_TEST_SECRET_KEY または STRIPE_SECRET_KEY を設定してください",
    );
  }
  return k;
}
