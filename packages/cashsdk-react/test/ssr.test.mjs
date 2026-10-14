import { CashSDKClient } from "cashsdk-web";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, StrictMode } from "react";
import { renderToString } from "react-dom/server";
import {
  CashSDKProvider,
  useBillingPortal,
  useCheckout,
  useCustomer,
  useEntitlements,
  useOfferings,
  usePurchase,
  useSubscriptions,
} from "../dist/index.js";

test("server rendering does not fetch or expose a reused client's customer state", async () => {
  let requests = 0;
  const sdk = new CashSDKClient({
    publishableKey: "csk_pk_example",
    environment: "sandbox",
    getSessionToken: async () => `csk_ws_${"a".repeat(43)}`,
    fetch: async (url) => {
      requests++;
      return Response.json(
        url.endsWith("/customer")
          ? { customerId: "private_customer", environment: "sandbox" }
          : {
              customerId: "private_customer",
              environment: "sandbox",
              revision: 1,
              computedAt: new Date().toISOString(),
              entitlements: [{ identifier: "pro", active: true }],
            },
      );
    },
  });
  await sdk.initialize();
  const count = requests;
  function Access() {
    const { snapshot, status } = useEntitlements();
    return createElement(
      "span",
      null,
      `${status}:${snapshot?.customerId ?? "none"}`,
    );
  }
  const html = renderToString(
    createElement(
      StrictMode,
      null,
      createElement(CashSDKProvider, { client: sdk }, createElement(Access)),
    ),
  );
  assert.equal(html, "<span>idle:none</span>");
  assert.equal(requests, count);
  sdk.destroy();
});

test("server rendering reads nothing for the customer and starts no checkout", async () => {
  let requests = 0;
  const sdk = new CashSDKClient({
    publishableKey: "csk_pk_example",
    environment: "sandbox",
    getSessionToken: async () => `csk_ws_${"a".repeat(43)}`,
    fetch: async (url) => {
      requests++;
      return Response.json(
        url.endsWith("/customer")
          ? { customerId: "private_customer", environment: "sandbox" }
          : {
              customerId: "private_customer",
              environment: "sandbox",
              revision: 1,
              computedAt: new Date().toISOString(),
              entitlements: [],
            },
      );
    },
  });
  await sdk.initialize();
  const count = requests;
  function Page() {
    const offerings = useOfferings();
    const subscriptions = useSubscriptions();
    const checkout = useCheckout();
    const purchase = usePurchase();
    return createElement(
      "span",
      null,
      [
        offerings.status,
        String(offerings.offerings),
        subscriptions.status,
        subscriptions.subscriptions.length,
        checkout.status,
        typeof checkout.start,
        purchase.status,
        typeof purchase.start,
      ].join(":"),
    );
  }
  const html = renderToString(
    createElement(
      StrictMode,
      null,
      createElement(CashSDKProvider, { client: sdk }, createElement(Page)),
    ),
  );
  assert.equal(html, "<span>idle:null:idle:0:idle:function:idle:function</span>");
  assert.equal(requests, count);
  sdk.destroy();
});

test("the billing portal opens only from a handler, and a double click is one request", async () => {
  const opened = [];
  let release;
  const sdk = new CashSDKClient({
    publishableKey: "csk_pk_example",
    environment: "sandbox",
    getSessionToken: async () => `csk_ws_${"a".repeat(43)}`,
    fetch: async (url, init) => {
      if (!url.endsWith("/billing-portal")) throw new Error(`unexpected ${url}`);
      opened.push(JSON.parse(init.body));
      await new Promise((resolve) => (release = resolve));
      return Response.json(
        {
          customerId: "customer_1",
          environment: "sandbox",
          provider: "stripe",
          url: "https://billing.stripe.com/p/session/test_1",
        },
        { status: 201 },
      );
    },
  });
  let hook;
  function Account() {
    hook = useBillingPortal();
    return createElement("span", null, `${hook.status}:${String(hook.portal)}`);
  }
  const html = renderToString(
    createElement(
      StrictMode,
      null,
      createElement(CashSDKProvider, { client: sdk }, createElement(Account)),
    ),
  );
  assert.equal(html, "<span>idle:null</span>");
  assert.equal(opened.length, 0, "rendering opens nothing");
  const input = { returnUrl: "http://localhost:3000/account" };
  const first = hook.start(input);
  const second = hook.start(input);
  assert.equal(first, second, "a second call while one is starting joins it");
  await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  assert.deepEqual(await first, { url: "https://billing.stripe.com/p/session/test_1" });
  assert.equal(opened.length, 1);
  assert.deepEqual(opened[0], input);
  const third = hook.start(input);
  assert.notEqual(third, first, "a later click opens a new session");
  await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  await third;
  assert.equal(opened.length, 2);
  sdk.destroy();
});

test("a lost connection reaches the hooks as a retryable network_error, and refresh recovers", async () => {
  let online = false;
  const sdk = new CashSDKClient({
    publishableKey: "csk_pk_example",
    environment: "sandbox",
    getSessionToken: async () => `csk_ws_${"a".repeat(43)}`,
    fetch: async (url) => {
      if (!online) throw new TypeError("Failed to fetch");
      return Response.json(
        url.endsWith("/customer")
          ? { customerId: "customer_1", environment: "sandbox" }
          : {
              customerId: "customer_1",
              environment: "sandbox",
              revision: 1,
              computedAt: new Date().toISOString(),
              entitlements: [{ identifier: "pro", active: true }],
            },
      );
    },
  });
  let access;
  let checkout;
  function Page() {
    access = useEntitlements();
    checkout = useCheckout();
    return null;
  }
  renderToString(
    createElement(CashSDKProvider, { client: sdk }, createElement(Page)),
  );
  const offline = (error) =>
    error.code === "network_error" && error.status === 0 && error.retryable;
  await assert.rejects(sdk.initialize(), offline);
  assert.equal(sdk.getSnapshot().status, "error");
  assert(offline(sdk.getSnapshot().error), "the client state carries the code");
  await assert.rejects(
    checkout.start(
      {
        packageId: "package_1",
        successUrl: "http://localhost:3000/done",
        cancelUrl: "http://localhost:3000/plans",
      },
      { idempotencyKey: "attempt_0123456789abcdef" },
    ),
    offline,
  );
  online = true;
  const snapshot = await access.refresh();
  assert.equal(snapshot.entitlements[0].identifier, "pro");
  assert.equal(sdk.getSnapshot().status, "ready", "a retry after a failed first load recovers");
  assert.equal(sdk.getSnapshot().customer.customerId, "customer_1");
  sdk.destroy();
});

test("hooks outside the provider fail with a message that says why", () => {
  function Orphan() {
    useOfferings();
    return null;
  }
  assert.throws(
    () => renderToString(createElement(Orphan)),
    /CashSDK hooks require CashSDKProvider/,
  );
});

test("a purchase starts only from a handler; a double click joins it and another package waits", async () => {
  const posted = [];
  let release;
  const sdk = new CashSDKClient({
    publishableKey: "csk_pk_example",
    environment: "sandbox",
    getSessionToken: async () => `csk_ws_${"a".repeat(43)}`,
    purchaseStorage: { get: () => null, set: () => {}, remove: () => {} },
    fetch: async (url, init) => {
      if (url.endsWith("/customer"))
        return Response.json({ customerId: "customer_1", environment: "sandbox" });
      if (!url.endsWith("/checkouts")) throw new Error(`unexpected ${url}`);
      posted.push({ key: init.headers["Idempotency-Key"], body: JSON.parse(init.body) });
      await new Promise((resolve) => (release = resolve));
      return Response.json(
        {
          id: "wco_1",
          provider: "stripe",
          environment: "sandbox",
          customerId: "customer_1",
          status: "requires_action",
          paymentStatus: null,
          accessStatus: "check_entitlements",
          action: { type: "redirect", url: "https://checkout.stripe.com/c/pay/wco_1" },
          expiresAt: null,
        },
        { status: 201 },
      );
    },
  });
  let hook;
  function Plans() {
    hook = usePurchase();
    return createElement("span", null, `${hook.status}:${String(hook.checkout)}`);
  }
  const html = renderToString(
    createElement(StrictMode, null, createElement(CashSDKProvider, { client: sdk }, createElement(Plans))),
  );
  assert.equal(html, "<span>idle:null</span>");
  assert.equal(posted.length, 0, "rendering buys nothing");
  const input = { successUrl: "http://localhost:3000/done", cancelUrl: "http://localhost:3000/plans" };
  const first = hook.start("pkg_monthly", input);
  assert.equal(hook.start("pkg_monthly", input), first, "a double click joins the running purchase");
  await assert.rejects(hook.start("pkg_yearly", input), (error) => {
    assert.equal(error.code, "purchase_in_progress");
    assert.equal(error.retryable, true);
    return true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  const checkout = await first;
  assert.equal(checkout.action.url, "https://checkout.stripe.com/c/pay/wco_1");
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].body, { packageId: "pkg_monthly", ...input });
  sdk.destroy();
});

test("hook errors are CashSDKErrors with a code, whatever failed", async () => {
  const sdk = new CashSDKClient({
    publishableKey: "csk_pk_example",
    environment: "sandbox",
    getSessionToken: async () => {
      throw new Error("Sign in to continue");
    },
  });
  let checkout;
  let purchase;
  let customer;
  function Page() {
    checkout = useCheckout();
    purchase = usePurchase();
    customer = useCustomer();
    return null;
  }
  renderToString(createElement(CashSDKProvider, { client: sdk }, createElement(Page)));
  await assert.rejects(
    checkout.start(
      { packageId: "package_1", successUrl: "http://localhost:3000/done", cancelUrl: "http://localhost:3000/plans" },
      { idempotencyKey: "attempt_0123456789abcdef" },
    ),
    (error) => error.code === "session_unavailable" && error.message === "Sign in to continue",
  );
  await assert.rejects(sdk.initialize(), { code: "session_unavailable" });
  assert.equal(sdk.getSnapshot().error.code, "session_unavailable");
  assert.equal(customer.error, null, "rendered before the failure, on the server");
  await assert.rejects(purchase.start("", { successUrl: "x", cancelUrl: "y" }), { code: "invalid_package" });
  sdk.destroy();
});
