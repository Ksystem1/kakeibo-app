import test from "node:test";
import assert from "node:assert/strict";
import { pickBestStripeSubscriptionForCustomer } from "../src/stripe-subscription-reconcile-core.mjs";
import { deriveSubscriptionStatusFromDbRow } from "../src/subscription-logic.mjs";

test("pickBestStripeSubscriptionForCustomer: active は canceled より優先", () => {
  const canceled = { status: "canceled", current_period_end: 2000000000, id: "sub_a" };
  const active = { status: "active", current_period_end: 1000000000, id: "sub_b" };
  const best = pickBestStripeSubscriptionForCustomer([canceled, active]);
  assert.equal(best?.status, "active");
});

test("deriveSubscriptionStatusFromDbRow: subscription_status があれば is_premium より優先", () => {
  const row = { subscription_status: "canceled", is_premium: 1 };
  assert.equal(deriveSubscriptionStatusFromDbRow(row), "canceled");
});

test("deriveSubscriptionStatusFromDbRow: status が空なら is_premium=1 で active", () => {
  const row = { subscription_status: "", is_premium: 1 };
  assert.equal(deriveSubscriptionStatusFromDbRow(row), "active");
});
