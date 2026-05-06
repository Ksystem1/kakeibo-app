import test from "node:test";
import assert from "node:assert/strict";
import { familyDbFieldsFromStripeSubscription } from "../src/subscription-logic.mjs";

test("familyDbFieldsFromStripeSubscription: 請求期間終了後の active は inactive に矯正", () => {
  const past = Math.floor(Date.now() / 1000) - 86400;
  const sub = { status: "active", current_period_end: past, cancel_at_period_end: false };
  const f = familyDbFieldsFromStripeSubscription(sub, Date.now());
  assert.equal(f.subscription_status, "inactive");
  assert.equal(f.periodExpiredDemoted, true);
  assert.equal(f.subscription_cancel_at_period_end, 0);
});

test("familyDbFieldsFromStripeSubscription: 期間内の active はそのまま", () => {
  const future = Math.floor(Date.now() / 1000) + 86400 * 30;
  const sub = { status: "active", current_period_end: future, cancel_at_period_end: false };
  const f = familyDbFieldsFromStripeSubscription(sub, Date.now());
  assert.equal(f.subscription_status, "active");
  assert.equal(f.periodExpiredDemoted, false);
});

test("familyDbFieldsFromStripeSubscription: canceled は期間超過でも canceled のまま", () => {
  const past = Math.floor(Date.now() / 1000) - 86400;
  const sub = { status: "canceled", current_period_end: past, cancel_at_period_end: false };
  const f = familyDbFieldsFromStripeSubscription(sub, Date.now());
  assert.equal(f.subscription_status, "canceled");
  assert.equal(f.periodExpiredDemoted, false);
});
