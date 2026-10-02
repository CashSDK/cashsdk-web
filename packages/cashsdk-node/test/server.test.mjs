import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { CashSDKError, CashSDKServer, verifyWebhook } from "../dist/index.js";

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

test("a lost connection is a retryable network_error, not a raw fetch error", async () => {
  const offline = new TypeError("fetch failed");
  const sdk = new CashSDKServer({
    secretKey: "csk_sk_test_example",
    environment: "sandbox",
    fetch: async () => {
      throw offline;
    },
  });
  await assert.rejects(sdk.getEntitlements("user1"), (error) => {
    assert(error instanceof CashSDKError);
    assert.equal(error.code, "network_error");
    assert.equal(error.status, 0);
    assert.equal(error.retryable, true);
    assert.equal(error.cause, offline);
    return true;
  });
  const reset = new CashSDKServer({
    secretKey: "csk_sk_test_example",
    environment: "sandbox",
    fetch: async () =>
      new Response(
        new ReadableStream({
          start: (controller) => controller.error(new TypeError("terminated")),
        }),
      ),
  });
  await assert.rejects(reset.getEntitlements("user1"), {
    code: "network_error",
    retryable: true,
  });
  const garbled = new CashSDKServer({
    secretKey: "csk_sk_test_example",
    environment: "sandbox",
    fetch: async () => new Response("not json", { status: 502 }),
  });
  await assert.rejects(garbled.getEntitlements("user1"), {
    code: "invalid_response",
    status: 502,
  });
});

test("an abort or a timeout is not reported as a lost connection", async () => {
  const failsOnAbort = (_url, init) =>
    new Promise((_resolve, reject) =>
      init.signal.addEventListener("abort", () =>
        reject(new TypeError("fetch failed")),
      ),
    );
  const slow = new CashSDKServer({
    secretKey: "csk_sk_test_example",
    environment: "sandbox",
    timeoutMs: 100,
    fetch: failsOnAbort,
  });
  await assert.rejects(slow.getEntitlements("user1"), { code: "timeout" });
  const controller = new AbortController();
  const waiting = slow.getEntitlements("user1", { signal: controller.signal });
  controller.abort(new Error("caller gave up"));
  await assert.rejects(waiting, /caller gave up/);
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

test("a billing portal is opened for the named customer in the configured environment", async () => {
  const requests = [];
  let answer = (url, body) => ({
    customerId: decodeURIComponent(url.split("/")[6]),
    environment: body.environment,
    provider: "stripe",
    url: "https://billing.stripe.com/p/session/test_1",
  });
  const sdk = new CashSDKServer({
    secretKey: "csk_rk_test_example",
    environment: "sandbox",
    fetch: async (url, init) => {
      requests.push({ url, ...init });
      return Response.json(answer(url, JSON.parse(init.body)), { status: 201 });
    },
  });
  const session = await sdk.createBillingPortalSession({
    customerId: "user/1",
    returnUrl: "https://app.example.com/account",
  });
  assert.equal(session.url, "https://billing.stripe.com/p/session/test_1");
  assert.equal(
    requests[0].url,
    "https://api.cashsdk.com/v1/web/customers/user%2F1/billing-portal",
  );
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].headers.Authorization, "Bearer csk_rk_test_example");
  assert.equal(requests[0].headers.Origin, undefined);
  assert.deepEqual(JSON.parse(requests[0].body), {
    environment: "sandbox",
    returnUrl: "https://app.example.com/account",
  });
  await sdk.createBillingPortalSession({
    customerId: "user_1",
    returnUrl: "https://app.example.com/account",
    configuration: "bpc_123",
  });
  assert.equal(JSON.parse(requests[1].body).configuration, "bpc_123");
  for (const input of [
    { customerId: "", returnUrl: "https://app.example.com" },
    { customerId: "c".repeat(201), returnUrl: "https://app.example.com" },
    { returnUrl: "https://app.example.com" },
  ])
    await assert.rejects(sdk.createBillingPortalSession(input), {
      code: "invalid_customer",
    });
  await assert.rejects(
    sdk.createBillingPortalSession({ customerId: "user_1", returnUrl: "" }),
    { code: "invalid_return_url" },
  );
  assert.equal(requests.length, 2, "invalid input sends nothing");
  for (const bad of [
    (url, body) => ({ customerId: "someone_else", environment: body.environment, provider: "stripe", url: "https://billing.stripe.com/p/session/x" }),
    () => ({ customerId: "user_1", environment: "production", provider: "stripe", url: "https://billing.stripe.com/p/session/x" }),
    () => ({ customerId: "user_1", environment: "sandbox", provider: "stripe", url: "https://evil.example/p/session/x" }),
    () => ({ customerId: "user_1", environment: "sandbox", provider: "stripe", url: "not a url" }),
  ]) {
    answer = bad;
    await assert.rejects(
      sdk.createBillingPortalSession({ customerId: "user_1", returnUrl: "https://app.example.com/account" }),
      { code: "invalid_response" },
    );
  }
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
