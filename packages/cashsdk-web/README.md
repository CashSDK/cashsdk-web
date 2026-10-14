# cashsdk-web

CashSDK for the browser: the signed-in customer, their access, their subscriptions, offerings
and checkout. No dependencies. Generally available on npm, including the Chrome extension
module. GitHub release archives are also available.

```sh
npm install cashsdk-web
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

Return your backend's session as it is. Its `expiresInSeconds` is read on this device's clock, so a
device whose clock is wrong still works. A provider that returns only `{ token, expiresAt }` works
too; CashSDK's 401 decides when a session has ended, and the SDK then asks your backend once for a
new one. When `getSessionToken` throws (nobody is signed in, say), the call fails with
`session_unavailable`, your error as its `cause` and its message kept.

## Selling a package

`purchase` starts the customer's checkout for a package, or picks up the one they already started.

```ts
const offerings = await cashsdk.getOfferings();
const pack = offerings.current?.packages.find((item) => item.purchasable);

buyButton.addEventListener("click", async () => {
  const checkout = await cashsdk.purchase(pack!.id, {
    successUrl: `${location.origin}/billing/return?package=${encodeURIComponent(pack!.id)}`,
    cancelUrl: `${location.origin}/pricing`,
  });
  if (checkout.action) location.assign(checkout.action.url);
  else if (checkout.status === "complete") showAlreadyPaid(); // access follows shortly
});
```

It keeps one idempotency key per customer and package in the tab's `sessionStorage` (memory when
storage is blocked), saves it before the request and saves the checkout before it resolves. A lost
answer, a retry, a double click or a reload reaches the same checkout, never a second one. When an
attempt is over, the next one gets a new key:

| What happened | `purchase` |
| --- | --- |
| The checkout waits for the customer | Returns it again: send them to `action.url` |
| Still being created (`pending`) | Asks again with the same key for a few seconds, then returns it |
| Expired or failed: nothing was charged | Starts a new checkout at once |
| Complete or `needs_review` | Returns it once and forgets it. The next call starts a new attempt |
| `already_subscribed`, `already_owned`, `already_purchased` | Rejects with that code and forgets the attempt |
| `checkout_in_progress`, a lost connection, a 5xx | Rejects, `retryable` is true, and keeps the key: call again |

On the page the customer returns to, wait for the payment and then for the access. Both arrive
from the provider's signed events, a few seconds after the customer is back.

```ts
const packageId = new URLSearchParams(location.search).get("package")!;
const outcome = await cashsdk.waitForPurchase(packageId, { timeoutMs: 60000 });
if (outcome?.settled && outcome.checkout.status === "complete") {
  const { active } = await cashsdk.waitForEntitlement("pro", { timeoutMs: 60000 });
}
```

`settled: false` means the checkout was still open when the time ran out. It never means the
payment failed. Returning to your page grants nothing by itself. `getPurchase(packageId)` reads the
attempt once, for example to show "Resume checkout". `checkout(input, { idempotencyKey })` is still
there if you keep keys yourself.

Checkout sells your Stripe subscriptions and one-time products. A refusal has a stable code:
`already_subscribed` (open the billing portal), `already_owned` (show it as owned),
`already_purchased` (wait for access with `waitForEntitlement`) and `checkout_in_progress`
(retry shortly). Replaying an idempotency key returns the original checkout.

## Billing portal

Let a customer update their card, cancel or read their invoices in Stripe's customer portal. The
session your backend issues needs the `billing:manage` scope.

```ts
const { url } = await cashsdk.openBillingPortal({ returnUrl: `${location.origin}/account` });
location.assign(url); // the method never navigates by itself; the link expires within minutes
```

CashSDK opens the portal only for the customer's own Stripe customer. `no_billing_account` means
there is none in this environment yet. Stripe pages are accepted on Stripe's hosts and on your
Stripe custom domain (`/c/pay/…` for Checkout, `/p/session/…` for the portal), over HTTPS on a real
domain name.

## Signing out

```ts
const { revocation } = await cashsdk.logout(); // resolves at once
await fetch("/logout", { method: "POST" });     // your sign-out ends every session of the customer
revocation.then(({ revoked, error }) => revoked || console.warn("CashSDK not reached", error?.code));
```

`logout` resolves as soon as the client holds nothing of the customer. Ending this tab's session at
CashSDK runs on its own; `revocation` never rejects. Other tabs of the same app (same publishable key
and environment) drop their access at once through a `BroadcastChannel`: a sign-out signs them out,
and `setSessionTokenProvider` for a new customer sends them back to `idle` so they load whoever is
signed in now. Where `BroadcastChannel` does not exist, each tab finds out on its next request.

## API

`initialize`, `getCustomer`, `getEntitlements`, `refreshEntitlements`, `getSubscriptions`,
`getOfferings`, `purchase`, `getPurchase`, `waitForPurchase`, `checkout`, `getCheckout`,
`waitForCheckout`, `waitForEntitlement`, `openBillingPortal`, `setSessionTokenProvider`, `logout`,
`destroy`, `subscribe`, `getSnapshot`.

Every failure is a `CashSDKError` with a stable `code`, the HTTP `status`, `retryable`,
`retryAfterMs` and the `requestId` to quote to support. Decide on `code`, never on `message`. A
request that never got a response is `network_error` (status 0, retryable). An error page from a
proxy is `http_<status>`, retryable for 429 and 5xx. `waitForCheckout`, `waitForPurchase` and
`waitForEntitlement` keep reading through those until their deadline; their `intervalMs` is 1000 to
5000. `invalid_publishable_key` is a configuration error: fix the key, the SDK does not ask your
backend for another session. A checkout status this version does not know reads as `pending`. A
checkout that belongs to another customer (one who signed in from another tab) is never returned:
the call fails with `identity_changed` and the client signs out.

Sessions and access stay in memory. Requests time out, can be cancelled, send no cookies and
refuse redirects. Changing the customer cancels their requests and ends their session.

## Requirements

Browsers with `fetch`, `AbortController` and ES2022. Node.js 20.19+ or 22.12+ for server
rendering, where the package imports safely and makes no request. ES modules only, with TypeScript
declarations: use `import`, a bundler, or `moduleResolution` `bundler`, `node16` or `nodenext`. With
the older `moduleResolution: "node"`, the types of `cashsdk-web/extension` still resolve. React
bindings: `cashsdk-react`. Server: `cashsdk-node`. Both take this package as a peer dependency, so
install the same version of all of them.

Guide: [docs.cashsdk.com/sdk/web](https://docs.cashsdk.com/sdk/web). License: MIT.

## Chrome extensions

`cashsdk-web/extension` exports `createExtensionCashSDK`, `extensionOrigin`,
`openCheckoutTab` and `openBillingPortalTab`. Pass `chrome.runtime` to the factory with
the normal client options, then use the same customer, offering, purchase and entitlement
methods. Bundle the SDK locally in an MV3 extension page or service worker. The factory throws
in a content script, which runs on the web page's origin. Request host permissions for the API
and your authenticated backend. Allow the exact extension origin and a hosted HTTPS return
origin in CashSDK. A service worker has no `sessionStorage`, so keep purchase attempts across
worker restarts with `chrome.storage.local`:

```ts
const cashsdk = createExtensionCashSDK({
  runtime: chrome.runtime,
  publishableKey: "csk_pk_…",
  environment: "sandbox",
  getSessionToken,
  purchaseStorage: {
    get: async (key) => (await chrome.storage.local.get(key))[key] ?? null,
    set: (key, value) => chrome.storage.local.set({ [key]: value }),
    remove: (key) => chrome.storage.local.remove(key),
  },
});
const checkout = await cashsdk.purchase(packageId, { successUrl, cancelUrl: successUrl });
if (checkout.status === "requires_action") await openCheckoutTab(chrome.tabs, checkout);
```

Never put a server key in an extension or accept billing commands from content scripts. Use
version `1.0.0` or later for the extension entry point and Stripe custom domains.

See https://docs.cashsdk.com/sdk/chrome-extension for the full setup and runnable example.
