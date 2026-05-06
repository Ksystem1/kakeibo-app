import test from "node:test";
import assert from "node:assert/strict";
import { coerceExpiredPaidSubscriptionRowForAuthMe } from "../src/subscription-logic.mjs";

test("coerceExpiredPaidSubscriptionRowForAuthMe: 期間終了後の active → inactive", () => {
  const past = new Date(Date.now() - 86400000);
  const row = {
    subscription_status: "active",
    subscription_period_end_at: past,
    subscription_cancel_at_period_end: 1,
    is_premium: 0,
  };
  const out = coerceExpiredPaidSubscriptionRowForAuthMe(row, 1, Date.now());
  assert.equal(out.subscription_status, "inactive");
  assert.equal(out.subscription_cancel_at_period_end, 0);
});

test("coerceExpiredPaidSubscriptionRowForAuthMe: 期間内はそのまま", () => {
  const future = new Date(Date.now() + 86400000 * 30);
  const row = { subscription_status: "active", subscription_period_end_at: future };
  const out = coerceExpiredPaidSubscriptionRowForAuthMe(row, 1, Date.now());
  assert.equal(out.subscription_status, "active");
});
