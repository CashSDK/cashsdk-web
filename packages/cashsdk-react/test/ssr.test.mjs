import { CashSDKClient } from "cashsdk-web";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, StrictMode } from "react";
import { renderToString } from "react-dom/server";
import {
  CashSDKProvider,
  useBillingPortal,
  useCheckout,
  useEntitlements,
  useOfferings,
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
  assert.equal(html, "<span>idle:null:idle:0:idle:function</span>");
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
