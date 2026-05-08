import test from "node:test";
import assert from "node:assert/strict";
import { pickBestStripeSubscriptionForCustomer } from "../src/stripe-subscription-reconcile-core.mjs";
import {
  deriveSubscriptionStatusFromDbRow,
  effectiveSubscriptionPeriodEndUnixFromStripe,
} from "../src/subscription-logic.mjs";

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

test("effectiveSubscriptionPeriodEndUnixFromStripe: cancel_at_period_end では cancel_at を優先", () => {
  const sub = {
    cancel_at_period_end: true,
    cancel_at: 1778707200,
    current_period_end: 1778000000,
  };
  assert.equal(effectiveSubscriptionPeriodEndUnixFromStripe(sub), 1778707200);
});

test("effectiveSubscriptionPeriodEndUnixFromStripe: cancel_at が無ければ current_period_end", () => {
  const sub = {
    cancel_at_period_end: true,
    cancel_at: null,
    current_period_end: 1778000000,
  };
  assert.equal(effectiveSubscriptionPeriodEndUnixFromStripe(sub), 1778000000);
});
