# cashsdk-web

CashSDK for the browser: the signed-in customer, their access, their subscriptions, offerings
and checkout. No dependencies. Version `0.1.0-alpha.0` is a preview on the `next` tag.

```sh
npm install cashsdk-web@next
```

```ts
import { createCashSDK } from "cashsdk-web";

const cashsdk = createCashSDK({
  publishableKey: "csk_pk_…",
  environment: "sandbox",
  // Your backend signs the customer in and returns a session from cashsdk-node.
  getSessionToken: async ({ signal }) => {
    const response = await fetch("/api/cashsdk/session", { method: "POST", credentials: "same-origin", signal });
    if (!response.ok) throw new Error("Sign in to continue");
    return response.json();
  },
});

await cashsdk.initialize();
const { entitlements } = await cashsdk.getEntitlements();
const isPro = entitlements.some((item) => item.identifier === "pro" && item.active);
```

The browser never holds a server key and never chooses which customer it is: both come from the
session your backend issues. Add your site's exact origin in the CashSDK dashboard first.

## Checkout

```ts
const offerings = await cashsdk.getOfferings();
const attempt = crypto.randomUUID(); // store it before the request, and reuse it on a retry
const checkout = await cashsdk.checkout(
  { packageId: offerings.current!.packages[0].id, successUrl: `${location.origin}/return`, cancelUrl: `${location.origin}/pricing` },
  { idempotencyKey: attempt },
);
if (checkout.action?.type === "redirect") location.assign(checkout.action.url);
```

On the page the customer returns to, wait for the payment and then for the access. Both arrive
from the provider's signed events, a few seconds after the customer is back.

```ts
const { checkout, settled } = await cashsdk.waitForCheckout(savedCheckoutId, { timeoutMs: 60000 });
if (settled && checkout.status === "complete") {
  const { active } = await cashsdk.waitForEntitlement("pro", { timeoutMs: 60000 });
}
```

`settled: false` means the checkout was still open when the time ran out. It never means the
payment failed. Returning to your page grants nothing by itself.

## API

`initialize`, `getCustomer`, `getEntitlements`, `refreshEntitlements`, `getSubscriptions`,
`getOfferings`, `checkout`, `getCheckout`, `waitForCheckout`, `waitForEntitlement`,
`setSessionTokenProvider`, `logout`, `destroy`, `subscribe`, `getSnapshot`.

Every failure is a `CashSDKError` with a stable `code`, the HTTP `status`, `retryable` and the
`requestId` to quote to support. Decide on `code`, never on `message`.

Sessions and access stay in memory. Requests time out, can be cancelled, send no cookies and
refuse redirects. A 401 asks your backend for a new session once. Changing the customer cancels
their requests and ends their session. `logout` ends this tab's session; end the customer's
other tabs from your backend with `revokeWebSessions`.

## Requirements

Browsers with `fetch`, `AbortController` and ES2022. Node.js 20.19+ or 22.12+ for server
rendering, where the package imports safely and makes no request. ES module with TypeScript
declarations. React bindings: `cashsdk-react`. Server: `cashsdk-node`.

Guide: [docs.cashsdk.com/sdk/web](https://docs.cashsdk.com/sdk/web). License: MIT.
