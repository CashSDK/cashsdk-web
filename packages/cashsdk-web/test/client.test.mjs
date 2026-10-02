import assert from "node:assert/strict";
import { test } from "node:test";
import { CashSDKClient, CashSDKError } from "../dist/index.js";

const token = (letter = "a") => `csk_ws_${letter.repeat(43)}`;
const customer = { customerId: "customer_1", environment: "sandbox" };
const snapshot = (revision = 1) => ({
  ...customer,
  revision,
  computedAt: new Date().toISOString(),
  entitlements: [
    {
      identifier: "pro",
      active: true,
      name: "Pro",
      rank: 1,
      source: "subscription",
    },
  ],
});
const json = (data, status = 200) => Response.json(data, { status });
const client = (options = {}) =>
  new CashSDKClient({
    publishableKey: "csk_pk_example",
    environment: "sandbox",
    getSessionToken: async () => token(),
    fetch: async (url) =>
      json(url.endsWith("/customer") ? customer : snapshot()),
    ...options,
  });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

test("initialization shares authentication and never sends cookies or redirects", async () => {
  let authentication = 0;
  const requests = [];
  const sdk = client({
    getSessionToken: async () => {
      authentication++;
      return token();
    },
    fetch: async (url, init) => {
      requests.push(init);
      return json(url.endsWith("/customer") ? customer : snapshot());
    },
  });
  const first = sdk.initialize();
  assert.equal(sdk.initialize(), first);
  assert.equal((await first).status, "ready");
  assert.equal(authentication, 1);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.credentials, "omit");
    assert.equal(request.redirect, "error");
    assert.equal(request.cache, "no-store");
    assert.equal(request.headers["X-CashSDK-Web-Session"], token());
  }
  assert(Object.isFrozen(sdk.getSnapshot().entitlements.entitlements[0]));
  sdk.destroy();
});

test("a rejected session is refreshed once, concurrent requests share the refresh", async () => {
  let refreshes = 0;
  const sdk = client({
    getSessionToken: async () => token(++refreshes === 1 ? "a" : "b"),
    fetch: async (url, init) =>
      init.headers["X-CashSDK-Web-Session"] === token("a")
        ? json({ code: "invalid_web_session" }, 401)
        : json(url.endsWith("/customer") ? customer : snapshot()),
  });
  await sdk.initialize();
  assert.equal(refreshes, 2);
  sdk.destroy();
});

test("out of order entitlement reads cannot resurrect revoked access", async () => {
  const old = deferred();
  let reads = 0;
  const sdk = client({
    fetch: async () =>
      ++reads === 1 ? old.promise : json({ ...snapshot(3), entitlements: [] }),
  });
  const pending = sdk.getEntitlements();
  await new Promise((r) => setImmediate(r));
  await sdk.getEntitlements();
  old.resolve(json(snapshot(2)));
  assert.deepEqual((await pending).entitlements, []);
  assert.equal(sdk.getSnapshot().entitlements.revision, 3);
  sdk.destroy();
});

test("switching identity aborts old requests even when a custom fetch ignores cancellation", async () => {
  const old = deferred();
  const sdk = client({ fetch: () => old.promise });
  const pending = sdk.getEntitlements();
  await new Promise((r) => setImmediate(r));
  sdk.setSessionTokenProvider(async () => token("b"));
  await assert.rejects(pending, { code: "identity_changed" });
  old.resolve(json(snapshot()));
  await new Promise((r) => setImmediate(r));
  assert.equal(sdk.getSnapshot().entitlements, null);
  sdk.destroy();
});

test("logout clears state before remote revocation and blocks implicit reauthentication", async () => {
  const revoke = deferred();
  const sdk = client({
    fetch: async (url) =>
      url.endsWith("/current")
        ? revoke.promise
        : json(url.endsWith("/customer") ? customer : snapshot()),
  });
  await sdk.initialize();
  const pending = sdk.logout();
  assert.equal(sdk.getSnapshot().status, "signed_out");
  assert.equal(sdk.getSnapshot().customer, null);
  await assert.rejects(sdk.getEntitlements(), { code: "signed_out" });
  revoke.resolve(json({ revoked: true }));
  await pending;
  sdk.destroy();
});

test("timeouts cover authentication callbacks and custom fetch implementations", async () => {
  for (const options of [
    { getSessionToken: () => new Promise(() => {}) },
    { fetch: () => new Promise(() => {}) },
  ]) {
    const sdk = client({ ...options, timeoutMs: 100 });
    await assert.rejects(sdk.getEntitlements(), { code: "timeout" });
    sdk.destroy();
  }
});

test("an unresponsive rejected-response stream cannot prevent request timeout", async () => {
  const sdk = client({
    timeoutMs: 100,
    fetch: async () =>
      new Response(
        new ReadableStream({ cancel: () => new Promise(() => {}) }),
        { status: 401 },
      ),
  });
  await assert.rejects(sdk.getEntitlements(), { code: "timeout" });
  sdk.destroy();
});

test("sign-out before the authentication microtask prevents session issuance", async () => {
  let calls = 0;
  const sdk = client({
    getSessionToken: async () => {
      calls++;
      return token();
    },
  });
  const pending = sdk.getCustomer();
  await sdk.logout();
  await assert.rejects(pending, { code: "identity_changed" });
  assert.equal(calls, 0);
  sdk.destroy();
});

test("malformed access and mismatched environments never enter the cache", async () => {
  for (const data of [
    { ...snapshot(), environment: "production" },
    { ...snapshot(), entitlements: [{ identifier: "pro", active: "true" }] },
    { ...snapshot(), revision: -1 },
  ]) {
    const sdk = client({ fetch: async () => json(data) });
    await assert.rejects(sdk.getEntitlements(), CashSDKError);
    assert.equal(sdk.getSnapshot().entitlements, null);
    sdk.destroy();
  }
});

test("secret keys and unsafe API URLs are rejected before any network call", () => {
  for (const options of [
    { publishableKey: "csk_sk_live_secret" },
    { environment: "production", apiUrl: "http://localhost:4000" },
    { apiUrl: "https://user:pass@example.com" },
    { apiUrl: "https://example.com/path" },
  ])
    assert.throws(() => client(options), CashSDKError);
});

test("a reset server cache revision does not retain revoked access forever", async () => {
  let reads = 0;
  const sdk = client({
    fetch: async () =>
      json(++reads === 1 ? snapshot(10) : { ...snapshot(0), entitlements: [] }),
  });
  await sdk.getEntitlements();
  assert.deepEqual((await sdk.getEntitlements()).entitlements, []);
  sdk.destroy();
});

test("checkout preserves caller idempotency and rejects untrusted redirect actions", async () => {
  let observed;
  const sdk = client({
    fetch: async (_url, init) => {
      observed = init;
      return json({
        id: "checkout1",
        provider: "stripe",
        environment: "sandbox",
        status: "requires_action",
        action: { type: "redirect", url: "https://attacker.example/pay" },
      });
    },
  });
  await assert.rejects(
    sdk.checkout(
      {
        packageId: "pkg",
        connectionId: "conn",
        successUrl: "https://merchant.example/return",
        cancelUrl: "https://merchant.example/cancel",
      },
      { idempotencyKey: "attempt_0000000001" },
    ),
    { code: "invalid_response" },
  );
  assert.equal(observed.headers["Idempotency-Key"], "attempt_0000000001");
  assert.equal(observed.method, "POST");
  sdk.destroy();
});

const checkoutState = (status, paymentStatus = null) => ({
  id: "checkout_1",
  provider: "stripe",
  environment: "sandbox",
  status,
  paymentStatus,
  accessStatus: "check_entitlements",
  action:
    status === "requires_action"
      ? { type: "redirect", url: "https://checkout.stripe.com/c/pay/cs_test_1" }
      : null,
  expiresAt: null,
});

test("waiting for a checkout ends when the provider reports a final state", async () => {
  const states = [
    checkoutState("requires_action"),
    checkoutState("complete", "unpaid"),
    checkoutState("complete", "paid"),
    checkoutState("expired"),
  ];
  let reads = 0;
  const sdk = client({ fetch: async () => json(states[reads++]) });
  const outcome = await sdk.waitForCheckout("checkout_1", { intervalMs: 100 });
  assert.equal(outcome.settled, true);
  assert.equal(outcome.checkout.paymentStatus, "paid");
  assert.equal(reads, 3);
  sdk.destroy();
});

test("a wait that runs out reports an open checkout, never a failed payment", async () => {
  let reads = 0;
  const sdk = client({
    fetch: async () => {
      reads++;
      return json(checkoutState("requires_action"));
    },
  });
  const started = Date.now();
  const outcome = await sdk.waitForCheckout("checkout_1", {
    timeoutMs: 350,
    intervalMs: 100,
  });
  assert.equal(outcome.settled, false);
  assert.equal(outcome.checkout.status, "requires_action");
  assert(reads >= 2 && reads <= 4);
  assert(Date.now() - started < 1500);
  const once = await sdk.waitForCheckout("checkout_1", { timeoutMs: 0 });
  assert.equal(once.settled, false);
  await assert.rejects(
    sdk.waitForCheckout("checkout_1", { timeoutMs: 300001 }),
    /timeoutMs/,
  );
  await assert.rejects(
    sdk.waitForCheckout("checkout_1", { intervalMs: 10 }),
    /intervalMs/,
  );
  sdk.destroy();
});

test("a wait survives failures a retry can fix and stops on ones it cannot", async () => {
  let reads = 0;
  const sdk = client({
    fetch: async () => {
      reads++;
      if (reads === 1)
        return json(
          { error: { code: "provider_request_failed", message: "Unavailable" } },
          503,
        );
      if (reads === 2)
        return Response.json(
          { error: { code: "rate_limited", message: "Slow down" } },
          { status: 429, headers: { "Retry-After": "0" } },
        );
      return json(checkoutState("complete", "paid"));
    },
  });
  const outcome = await sdk.waitForCheckout("checkout_1", { intervalMs: 100 });
  assert.equal(outcome.settled, true);
  assert.equal(reads, 3);
  const refused = client({
    fetch: async () =>
      json(
        { error: { code: "checkout_not_found", message: "Checkout not found" } },
        404,
      ),
  });
  await assert.rejects(
    refused.waitForCheckout("checkout_1", { intervalMs: 100 }),
    (error) => error.code === "checkout_not_found",
  );
  const down = client({
    fetch: async () =>
      json({ error: { code: "service_unavailable", message: "Down" } }, 503),
  });
  await assert.rejects(
    down.waitForCheckout("checkout_1", { timeoutMs: 250, intervalMs: 100 }),
    (error) => error.code === "service_unavailable" && error.retryable,
  );
  sdk.destroy();
  refused.destroy();
  down.destroy();
});

test("a caller or a sign-out ends a wait at once", async () => {
  const sdk = client({
    fetch: async (url) =>
      json(
        url.endsWith("/customer")
          ? customer
          : url.endsWith("/entitlements")
            ? { ...snapshot(), entitlements: [] }
            : checkoutState("requires_action"),
      ),
  });
  const controller = new AbortController();
  const waiting = sdk.waitForCheckout("checkout_1", {
    signal: controller.signal,
    timeoutMs: 60000,
  });
  setTimeout(() => controller.abort(new Error("left the page")), 50);
  const started = Date.now();
  await assert.rejects(waiting, /left the page/);
  assert(Date.now() - started < 1000);

  const access = sdk.waitForEntitlement("pro", { timeoutMs: 60000 });
  setTimeout(() => void sdk.logout(), 50);
  await assert.rejects(access, (error) => error.code === "identity_changed");
  await assert.rejects(
    sdk.waitForEntitlement("pro"),
    (error) => error.code === "signed_out",
  );
  sdk.destroy();
});

test("a lost connection is a retryable network_error, not a raw fetch error", async () => {
  const offline = new TypeError("Failed to fetch");
  const sdk = client({
    fetch: async () => {
      throw offline;
    },
  });
  await assert.rejects(sdk.getCustomer(), (error) => {
    assert(error instanceof CashSDKError);
    assert.equal(error.code, "network_error");
    assert.equal(error.status, 0);
    assert.equal(error.retryable, true);
    assert.equal(error.cause, offline);
    return true;
  });
  const reset = client({
    fetch: async () =>
      new Response(
        new ReadableStream({
          start: (controller) => controller.error(new TypeError("terminated")),
        }),
        { status: 200 },
      ),
  });
  await assert.rejects(
    reset.getEntitlements(),
    (error) => error.code === "network_error" && error.retryable,
  );
  const garbled = client({
    fetch: async () => new Response("not json", { status: 200 }),
  });
  await assert.rejects(
    garbled.getEntitlements(),
    (error) => error.code === "invalid_response",
  );
  sdk.destroy();
  reset.destroy();
  garbled.destroy();
});

test("a wait keeps reading through a lost connection until its deadline", async () => {
  let reads = 0;
  const sdk = client({
    fetch: async (url) => {
      reads++;
      if (reads <= 2) throw new TypeError("Failed to fetch");
      return json(
        url.endsWith("/entitlements")
          ? snapshot()
          : checkoutState("complete", "paid"),
      );
    },
  });
  const outcome = await sdk.waitForCheckout("checkout_1", { intervalMs: 100 });
  assert.equal(outcome.settled, true);
  assert.equal(reads, 3);
  reads = 0;
  const access = await sdk.waitForEntitlement("pro", { intervalMs: 100 });
  assert.equal(access.active, true);
  assert.equal(reads, 3);

  let seen = 0;
  const flaky = client({
    fetch: async () => {
      if (seen++ === 0) return json(checkoutState("requires_action"));
      throw new TypeError("Failed to fetch");
    },
  });
  const open = await flaky.waitForCheckout("checkout_1", {
    timeoutMs: 300,
    intervalMs: 100,
  });
  assert.equal(open.settled, false, "the last checkout read is kept");
  assert.equal(open.checkout.status, "requires_action");
  assert(seen >= 2);

  const down = client({
    fetch: async () => {
      throw new TypeError("Failed to fetch");
    },
  });
  await assert.rejects(
    down.waitForEntitlement("pro", { timeoutMs: 250, intervalMs: 100 }),
    (error) => error.code === "network_error",
  );
  sdk.destroy();
  flaky.destroy();
  down.destroy();
});

test("an abort, a sign-out or a timeout still ends a wait through a lost connection", async () => {
  const offline = () =>
    client({
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
  const sdk = offline();
  const controller = new AbortController();
  const waiting = sdk.waitForEntitlement("pro", {
    signal: controller.signal,
    timeoutMs: 60000,
    intervalMs: 100,
  });
  setTimeout(() => controller.abort(new Error("left the page")), 150);
  const started = Date.now();
  await assert.rejects(waiting, /left the page/);
  assert(Date.now() - started < 1000);

  const signedOut = offline();
  const access = signedOut.waitForCheckout("checkout_1", {
    timeoutMs: 60000,
    intervalMs: 100,
  });
  let loggedOut;
  setTimeout(() => {
    loggedOut = signedOut.logout();
    loggedOut.catch(() => {});
  }, 150);
  await assert.rejects(access, (error) => error.code === "identity_changed");
  // Ending the session at CashSDK needs the network too, and says so.
  await assert.rejects(loggedOut, (error) => error.code === "network_error");
  assert.equal(signedOut.getSnapshot().status, "signed_out");

  // A fetch that fails once it is aborted reports the timeout, not a lost connection.
  const slow = client({
    timeoutMs: 100,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal.addEventListener("abort", () =>
          reject(new TypeError("Failed to fetch")),
        ),
      ),
  });
  await assert.rejects(slow.getEntitlements(), { code: "timeout" });
  // A custom fetch's own abort is not reported as a network failure.
  const custom = client({
    fetch: async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    },
  });
  await assert.rejects(custom.getEntitlements(), { name: "AbortError" });
  sdk.destroy();
  signedOut.destroy();
  slow.destroy();
  custom.destroy();
});

test("waiting for an entitlement follows access as it arrives and expires", async () => {
  let reads = 0;
  const past = new Date(Date.now() - 1000).toISOString();
  const sdk = client({
    fetch: async () => {
      reads++;
      if (reads === 1) return json({ ...snapshot(), entitlements: [] });
      if (reads === 2)
        return json({
          ...snapshot(),
          entitlements: [{ ...snapshot().entitlements[0], expiresAt: past }],
        });
      return json(snapshot());
    },
  });
  const outcome = await sdk.waitForEntitlement("pro", { intervalMs: 100 });
  assert.equal(outcome.active, true);
  assert.equal(reads, 3);
  assert.equal(sdk.getSnapshot().entitlements, outcome.snapshot);
  const other = await sdk.waitForEntitlement("team", {
    timeoutMs: 150,
    intervalMs: 100,
  });
  assert.equal(other.active, false);
  await assert.rejects(sdk.waitForEntitlement(""), /identifier/);
  sdk.destroy();
});

test("the server's retry advice and request id reach the error", async () => {
  const sdk = client({
    fetch: async () =>
      Response.json(
        {
          error: {
            code: "provider_rejected",
            message: "Refused",
            retryable: false,
            requestId: "req_from_body",
          },
        },
        { status: 503, headers: { "X-Request-Id": "req_from_header" } },
      ),
  });
  await assert.rejects(sdk.getCustomer(), (error) => {
    assert.equal(error.code, "provider_rejected");
    assert.equal(error.retryable, false);
    assert.equal(error.requestId, "req_from_header");
    return true;
  });
  sdk.destroy();
});

test("a checkout can leave the connection to the server", async () => {
  let sent;
  const sdk = client({
    fetch: async (_url, init) => {
      sent = JSON.parse(init.body);
      return json(checkoutState("requires_action"));
    },
  });
  await sdk.checkout(
    {
      packageId: "package_1",
      successUrl: "https://merchant.example/return",
      cancelUrl: "https://merchant.example/pricing",
    },
    { idempotencyKey: "purchase_attempt_0001" },
  );
  assert.deepEqual(Object.keys(sent).sort(), [
    "cancelUrl",
    "packageId",
    "successUrl",
  ]);
  sdk.destroy();
});

test("changing the customer ends the previous session without waiting for it", async () => {
  const revoked = [];
  let fail = false;
  let issued = 0;
  const sdk = client({
    getSessionToken: async () => token(++issued === 1 ? "a" : "b"),
    fetch: async (url, init) => {
      if (init.method === "DELETE") {
        revoked.push(init.headers["X-CashSDK-Web-Session"]);
        if (fail) throw new TypeError("network unreachable");
        return json({ revoked: true });
      }
      return json(url.endsWith("/customer") ? customer : snapshot());
    },
  });
  // No session yet, so there is nothing to end.
  sdk.setSessionTokenProvider(async () => token("a"));
  assert.equal(revoked.length, 0);
  await sdk.initialize();
  sdk.setSessionTokenProvider(async () => token("b"));
  assert.equal(sdk.getSnapshot().status, "idle");
  assert.equal(sdk.getSnapshot().entitlements, null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(revoked, [token("a")]);
  await sdk.initialize();
  fail = true;
  sdk.setSessionTokenProvider(async () => token("c"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(revoked, [token("a"), token("b")]);
  assert.equal(sdk.getSnapshot().status, "idle");
  sdk.destroy();
});

test("subscriptions belong to the signed-in customer and are checked before use", async () => {
  const item = {
    productIdentifier: "pro_monthly",
    displayName: "Pro",
    provider: "stripe",
    status: "active",
    active: true,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    autoRenew: true,
    trial: false,
  };
  let body = { ...customer, subscriptions: [item] };
  const sdk = client({ fetch: async () => json(body) });
  const result = await sdk.getSubscriptions();
  assert.equal(result.subscriptions[0].provider, "stripe");
  for (const bad of [
    { ...customer, subscriptions: null },
    { ...customer, subscriptions: [{ ...item, active: "yes" }] },
    { ...customer, subscriptions: [{ ...item, expiresAt: "soon" }] },
    { ...customer, subscriptions: [{ ...item, productIdentifier: 7 }] },
    { ...customer, subscriptions: [null] },
  ]) {
    body = bad;
    await assert.rejects(sdk.getSubscriptions(), (error) => error.code === "invalid_response");
  }
  body = { ...customer, environment: "production", subscriptions: [] };
  await assert.rejects(sdk.getSubscriptions(), (error) => error.code === "environment_mismatch");
  sdk.destroy();
});

test("the billing portal is the signed-in customer's, on Stripe, and never navigates by itself", async () => {
  const portal = {
    ...customer,
    provider: "stripe",
    url: "https://billing.stripe.com/p/session/test_1",
  };
  let body = portal;
  let observed;
  const sdk = client({
    fetch: async (url, init) => {
      observed = { url, ...init };
      return json(body, 201);
    },
  });
  const opened = await sdk.openBillingPortal({
    returnUrl: "https://merchant.example/account",
  });
  assert.deepEqual(opened, { url: "https://billing.stripe.com/p/session/test_1" });
  assert.equal(observed.url, "https://api.cashsdk.com/v1/web/billing-portal");
  assert.equal(observed.method, "POST");
  assert.deepEqual(JSON.parse(observed.body), {
    returnUrl: "https://merchant.example/account",
  });
  assert.equal(observed.credentials, "omit");
  assert.equal(observed.redirect, "error");
  assert.equal(observed.headers["Idempotency-Key"], undefined);
  for (const bad of [
    { ...portal, url: "https://attacker.example/p/session/x" },
    { ...portal, url: "https://billing.stripe.com.attacker.example/p" },
    { ...portal, url: "http://billing.stripe.com/p/session/x" },
    { ...portal, url: "https://billing.stripe.com:444/p/session/x" },
    { ...portal, url: "not a url" },
    { ...portal, url: null },
    { ...portal, provider: "paypal" },
  ]) {
    body = bad;
    await assert.rejects(
      sdk.openBillingPortal({ returnUrl: "https://merchant.example/account" }),
      { code: "invalid_response" },
    );
  }
  body = { ...portal, environment: "production" };
  await assert.rejects(
    sdk.openBillingPortal({ returnUrl: "https://merchant.example/account" }),
    { code: "environment_mismatch" },
  );
  const requests = observed;
  for (const input of [{}, { returnUrl: "" }, { returnUrl: 7 }, { returnUrl: "x".repeat(2049) }, null])
    await assert.rejects(sdk.openBillingPortal(input), { code: "invalid_return_url" });
  assert.equal(observed, requests, "an invalid return URL sends nothing");
  sdk.destroy();
});

test("the billing portal reports the server's refusal by its code", async () => {
  const sdk = client({
    fetch: async () =>
      json(
        {
          error: {
            code: "no_billing_account",
            message: "This customer has no Stripe billing account in this environment",
            retryable: false,
            requestId: "req_portal",
          },
        },
        404,
      ),
  });
  await assert.rejects(
    sdk.openBillingPortal({ returnUrl: "https://merchant.example/account" }),
    (error) => {
      assert(error instanceof CashSDKError);
      assert.equal(error.code, "no_billing_account");
      assert.equal(error.status, 404);
      assert.equal(error.retryable, false);
      assert.equal(error.requestId, "req_portal");
      return true;
    },
  );
  sdk.destroy();
});

test("a portal opened for one customer is not returned after the customer changes", async () => {
  let release;
  const sdk = client({
    fetch: () =>
      new Promise((resolve) => {
        release = () =>
          resolve(
            json({
              ...customer,
              provider: "stripe",
              url: "https://billing.stripe.com/p/session/test_1",
            }),
          );
      }),
  });
  const opening = sdk.openBillingPortal({ returnUrl: "https://merchant.example/account" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  sdk.setSessionTokenProvider(async () => token("b"));
  release();
  await assert.rejects(opening, (error) => error.code === "identity_changed");
  sdk.destroy();
});
