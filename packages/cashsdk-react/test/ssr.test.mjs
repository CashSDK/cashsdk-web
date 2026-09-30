import { CashSDKClient } from "cashsdk-web";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, StrictMode } from "react";
import { renderToString } from "react-dom/server";
import {
  CashSDKProvider,
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
