# cashsdk-node

CashSDK for your backend: customer sessions for the browser, access checks, and CashSDK webhook
signatures, and Stripe customer portal sessions. Node.js 20.19+ or 22.12+. Version `0.1.0-alpha.1` is a preview on the `next` tag.
Keep it on the server: it holds your secret key.

```sh
npm install cashsdk-node@next
```

```ts
import { CashSDKServer } from "cashsdk-node";

const cashsdk = new CashSDKServer({ secretKey: process.env.CASHSDK_SECRET_KEY!, environment: "sandbox" });

// In your session endpoint, after your own authentication:
const session = await cashsdk.createWebSession({
  customerId: currentUser.id, // from your verified session, never from the request body
  origin: "https://app.example.com",
});
// Return it with Cache-Control: no-store.
```

Protect that endpoint against CSRF the way your framework does. Use a restricted key with
`web_sessions:write`, in the key's own environment (`csk_rk_test_…` for sandbox).

| Method | Does |
| --- | --- |
| `createWebSession({ customerId, origin, scopes?, ttlSeconds? })` | A session of at most ten minutes for one customer and one origin |
| `revokeWebSessions(customerId)` | Ends every session of that customer. Call it on sign-out: each tab holds its own |
| `getEntitlements(customerId)` | The customer's access, to check before you serve anything paid for |
| `createBillingPortalSession({ customerId, returnUrl, configuration? })` | A Stripe customer portal session for that customer's own Stripe customer (preview) |
| `verifyWebhook(rawBody, signatureHeader, { secrets })` | Checks a CashSDK webhook over its exact bytes, then parses it |

`verifyWebhook` takes the raw request body and the `X-CashSDK-Signature` header, accepts several
secrets while you rotate, and rejects old timestamps. Store each event id before you act on it,
because a webhook can arrive more than once. It does not verify Stripe or PayPal webhooks.

Errors are `CashSDKError` with a stable `code`, `status`, `retryable` and `requestId`. A request
that never got a response is `network_error` (status 0, retryable). The package
is an ES module; on the Node.js versions above, a CommonJS app can `require` it too.

Guide: [docs.cashsdk.com/sdk/web](https://docs.cashsdk.com/sdk/web). License: MIT.
