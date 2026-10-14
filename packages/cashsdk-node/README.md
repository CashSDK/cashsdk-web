# cashsdk-node

CashSDK for your backend: customer sessions for the browser, access checks, and CashSDK webhook
signatures, and Stripe customer portal sessions. Node.js 20.19+ or 22.12+. Version
`1.0.0` is generally available on npm. `cashsdk-web` is a peer dependency: install the
same version of both. Keep this package on the server: it holds your secret key.

```sh
npm install cashsdk-web@1.0.0 cashsdk-node@1.0.0
```

```ts
import { CashSDKServer } from "cashsdk-node";

const cashsdk = new CashSDKServer({ secretKey: process.env.CASHSDK_SECRET_KEY!, environment: "sandbox" });

// In your session endpoint, after your own authentication:
const session = await cashsdk.createWebSession({
  customerId: currentUser.id, // from your verified session, never from the request body
  origin: "https://app.example.com",
});
// Return the whole object with Cache-Control: no-store. The browser SDK reads its
// expiresInSeconds on the device's own clock, so a wrong clock there does not matter.
```

Protect that endpoint against CSRF the way your framework does. Use a restricted key with
`web_sessions:write`, in the key's own environment (`csk_rk_test_…` for sandbox).

| Method | Does |
| --- | --- |
| `createWebSession({ customerId, origin, scopes?, ttlSeconds? })` | A session of at most ten minutes for one customer and one origin |
| `revokeWebSessions(customerId)` | Ends every session of that customer. Call it on sign-out: each tab holds its own |
| `getEntitlements(customerId)` | The customer's access, to check before you serve anything paid for |
| `createBillingPortalSession({ customerId, returnUrl, configuration? })` | A Stripe customer portal session for that customer's own Stripe customer |
| `verifyWebhook(rawBody, signatureHeader, { secrets })` | Checks a CashSDK webhook over its exact bytes, then parses it |

`getEntitlements` answers `{ object, app_user_id, customer_exists, environment, tier,
tier_identifier, entitlements }`, each entitlement with `identifier`, `name`, `rank` and `source`.
Only access the customer has right now is listed.

```ts
const access = await cashsdk.getEntitlements(currentUser.id);
if (!access.entitlements.some((item) => item.identifier === "pro")) return res.status(403).end();
```

`createBillingPortalSession` accepts a portal on Stripe's host or on your Stripe custom domain
(`/p/session/…`), over HTTPS on a real domain name.

## Webhooks

`verifyWebhook` takes the raw request body and the `X-CashSDK-Signature` header, accepts several
secrets while you rotate, and rejects old timestamps. It throws a `CashSDKError` when the request is
not a genuine CashSDK webhook: answer 400 then, not 500. Store each event id before you act on it,
because a webhook can arrive more than once. It does not verify Stripe or PayPal webhooks.

```ts
import express from "express";
import { CashSDKError, verifyWebhook, type WebhookEvent } from "cashsdk-node";

const app = express();
app.post("/webhooks/cashsdk", express.raw({ type: "application/json" }), (req, res) => {
  let event: WebhookEvent;
  try {
    event = verifyWebhook(req.body, req.get("X-CashSDK-Signature") ?? "", {
      secrets: [process.env.CASHSDK_WEBHOOK_SECRET!], // add the new secret here while you rotate
    });
  } catch (error) {
    // invalid_signature or invalid_webhook: not from CashSDK, altered, or too old.
    if (error instanceof CashSDKError && error.code !== "invalid_webhook_configuration")
      return res.sendStatus(400);
    throw error; // your own configuration is wrong: a 500, and CashSDK sends it again
  }
  // Store event.id first: a webhook can arrive more than once.
  res.sendStatus(200);
});
```

## Errors

Errors are `CashSDKError` with a stable `code`, `status`, `retryable`, `retryAfterMs` and
`requestId`. A request that never got a response is `network_error` (status 0, retryable). An
error page from a proxy is `http_<status>`, retryable for 429 and 5xx. Bad input, such as an empty
customer id, rejects with `invalid_customer` like any other failure. The package is an ES module;
on the Node.js versions above, a CommonJS app can `require` it too.

Guide: [docs.cashsdk.com/sdk/web](https://docs.cashsdk.com/sdk/web). License: MIT.
