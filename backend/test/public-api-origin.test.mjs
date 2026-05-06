import test from "node:test";
import assert from "node:assert/strict";
import { resolvePublicApiOriginForStripe } from "../src/public-api-origin.mjs";

test("resolvePublicApiOriginForStripe: env STRIPE_WEBHOOK_PUBLIC_API_ORIGIN が最優先", () => {
  const origin = resolvePublicApiOriginForStripe(
    { host: "127.0.0.1:3456" },
    {
      STRIPE_WEBHOOK_PUBLIC_API_ORIGIN: "https://api.example.com/",
      PUBLIC_API_ORIGIN: "https://ignored.example.com",
    },
  );
  assert.equal(origin, "https://api.example.com");
});

test("resolvePublicApiOriginForStripe: X-Forwarded-Host + Proto（ALB 想定）", () => {
  const origin = resolvePublicApiOriginForStripe({
    host: "10.0.0.1:8080",
    "x-forwarded-host": "api.ksystemapp.com",
    "x-forwarded-proto": "https",
  });
  assert.equal(origin, "https://api.ksystemapp.com");
});

test("resolvePublicApiOriginForStripe: ローカル host は http", () => {
  const origin = resolvePublicApiOriginForStripe({ host: "localhost:3456" });
  assert.equal(origin, "http://localhost:3456");
});
