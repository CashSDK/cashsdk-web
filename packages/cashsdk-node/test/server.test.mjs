import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { CashSDKServer, verifyWebhook } from "../dist/index.js";

const now = new Date("2026-09-29T12:00:00Z");
const timestamp = Math.floor(now.getTime() / 1000);
const raw = Buffer.from(
  '{"id":"evt_1","type":"purchase.completed","data":{"name":"Café"}}',
);
const signature = (secret, time = timestamp, bytes = raw) =>
  `t=${time},v1=${createHmac("sha256", secret).update(`${time}.`).update(bytes).digest("hex")}`;

test("webhook verification accepts rotation and preserves exact bytes", () => {
  assert.equal(
    verifyWebhook(raw, signature("old"), { secrets: ["new", "old"], now }).id,
    "evt_1",
  );
  assert.equal(
    verifyWebhook(
      raw,
      `${signature("bad")},${signature("new").split(",")[1]}`,
      { secrets: ["new"], now },
    ).id,
    "evt_1",
  );
  assert.throws(
    () =>
      verifyWebhook(Buffer.concat([raw, Buffer.from(" ")]), signature("old"), {
        secrets: ["old"],
        now,
      }),
    { code: "invalid_signature" },
  );
});

test("expired, future, duplicated timestamps and invalid signatures fail closed", () => {
  for (const header of [
    signature("secret", timestamp - 301),
    signature("secret", timestamp + 301),
    `${signature("secret")},t=${timestamp}`,
    "t=NaN,v1=abc",
    signature("wrong"),
  ])
    assert.throws(
      () => verifyWebhook(raw, header, { secrets: ["secret"], now }),
      { code: "invalid_signature" },
    );
  assert.throws(() =>
    verifyWebhook(raw, signature("secret"), { secrets: [], now }),
  );
});

test("session creation binds the configured environment and sends only server credentials", async () => {
  let observed;
  const sdk = new CashSDKServer({
    secretKey: "csk_rk_test_example",
    environment: "sandbox",
    fetch: async (url, init) => {
      observed = { url, ...init };
      return Response.json({ token: "session" });
    },
  });
  await sdk.createWebSession({
    customerId: "customer_1",
    origin: "http://localhost:3000",
  });
  assert.equal(observed.url, "https://api.cashsdk.com/v1/web/sessions");
  assert.equal(JSON.parse(observed.body).environment, "sandbox");
  assert.equal(observed.headers.Authorization, "Bearer csk_rk_test_example");
  assert.equal(observed.redirect, "error");
  assert.throws(
    () =>
      new CashSDKServer({
        secretKey: "csk_sk_live_example",
        environment: "sandbox",
      }),
    { code: "environment_mismatch" },
  );
});

test("customer path segments are encoded and read environments are explicit", async () => {
  let observed;
  const sdk = new CashSDKServer({
    secretKey: "csk_sk_test_example",
    environment: "sandbox",
    fetch: async (url) => {
      observed = url;
      return Response.json({});
    },
  });
  await sdk.getEntitlements("user/a?b");
  assert(observed.endsWith("/user%2Fa%3Fb/entitlements?environment=Sandbox"));
});

test("timeouts also bound injected fetchers that ignore AbortSignal", async () => {
  const sdk = new CashSDKServer({
    secretKey: "csk_sk_test_example",
    environment: "sandbox",
    timeoutMs: 100,
    fetch: () => new Promise(() => {}),
  });
  await assert.rejects(sdk.getEntitlements("user1"), { code: "timeout" });
});

test("sign-out ends every session of one customer in the configured environment", async () => {
  let observed;
  const sdk = new CashSDKServer({
    secretKey: "csk_rk_test_example",
    environment: "sandbox",
    fetch: async (url, init) => {
      observed = { url, ...init };
      return Response.json({ revoked: 3 });
    },
  });
  assert.deepEqual(await sdk.revokeWebSessions("customer_1"), { revoked: 3 });
  assert.equal(observed.url, "https://api.cashsdk.com/v1/web/sessions:revoke");
  assert.equal(observed.method, "POST");
  assert.deepEqual(JSON.parse(observed.body), {
    customerId: "customer_1",
    environment: "sandbox",
  });
  assert.equal(observed.headers.Authorization, "Bearer csk_rk_test_example");
  assert.throws(() => sdk.revokeWebSessions(""), { code: "invalid_customer" });
  assert.throws(() => sdk.revokeWebSessions("c".repeat(201)), {
    code: "invalid_customer",
  });
});

test("the server's code, retry advice and request id reach the error", async () => {
  const sdk = new CashSDKServer({
    secretKey: "csk_rk_test_example",
    environment: "sandbox",
    fetch: async () =>
      Response.json(
        {
          error: {
            code: "origin_not_allowed",
            message: "Configure and enable this browser origin first",
            retryable: false,
            requestId: "req_from_body",
          },
        },
        { status: 403 },
      ),
  });
  await assert.rejects(
    sdk.createWebSession({ customerId: "customer_1", origin: "https://a.example" }),
    (error) => {
      assert.equal(error.code, "origin_not_allowed");
      assert.equal(error.status, 403);
      assert.equal(error.retryable, false);
      assert.equal(error.requestId, "req_from_body");
      return true;
    },
  );
});
