# Changelog

## 1.0.0

First stable release. Stripe checkout started by the SDK is available in Sandbox and Production
for websites, Chrome extensions and directly distributed Mac apps.

- `cashsdk-web`: `purchase(packageId, urls)`, `getPurchase(packageId)` and `waitForPurchase()`.
  A purchase resumes the customer's open checkout for that package, retries a pending one with
  the same idempotency key and starts a new attempt once the last one is over. Attempts are kept
  in `sessionStorage` by default (`purchaseStorage` replaces it).
- Checkout sells Stripe subscriptions and one-time products, with free trials from the product's
  intro offer, optional promotion codes and Stripe Tax. Payments are card only, so access never
  starts before the money arrives. Sessions last 60 minutes.
- New refusal codes: `already_subscribed`, `already_owned`, `already_purchased` (409) and
  `checkout_in_progress` (retryable, with `Retry-After`). `invalid_publishable_key` (403) no
  longer looks like an expired session.
- Checkout and billing portal URLs on a Stripe custom domain are accepted.
- Session expiry follows `expiresInSeconds`, so a wrong device clock no longer ends a session
  early or keeps one too long.
- `logout()` resolves to `{ revocation }` once local access is gone. A sign-out or a customer
  change in one tab reaches the other tabs of the same site.
- Errors without a JSON body become `http_<status>`, retryable for 429 and 5xx, and keep
  `Retry-After`. An `intervalMs` below 1000 is refused, so waits poll at most once a second.
- `cashsdk-react`: `usePurchase()`. Every hook error is a `CashSDKError`, and a result or error
  for one customer is never shown to the next.
- `cashsdk-react` and `cashsdk-node` take `cashsdk-web` as a peer dependency.
- `cashsdk-node`: `Retry-After` is kept on errors, methods reject bad input asynchronously, and
  `getEntitlements` returns the server's shape (`object`, `rank`).
- `cashsdk-web/extension` refuses to run in a content script.

## 0.1.0-alpha.2

- Add the MV3 extension entry point and runnable Chrome example.
- Validate exact extension origins and hosted Stripe return URLs.
- Preserve durable checkout attempts across extension worker restarts.
- SDK-started checkout remains gated on the production service.

## 0.1.0-alpha.1

Preview: the Stripe customer portal.

- `cashsdk-web`: `openBillingPortal({ returnUrl })` returns `{ url }`, a Stripe customer
  portal session for the signed-in customer. It never navigates by itself. The session needs
  the new `billing:manage` scope, which is not a default.
- `cashsdk-react`: `useBillingPortal()`, started from a handler. A second call while one is
  starting joins it, and a portal opened for one customer is never shown to the next.
- `cashsdk-node`: `createBillingPortalSession({ customerId, returnUrl, configuration? })`
  for your backend, and `billing:manage` in the session scope type.
- New error codes: `no_billing_account` (404), `billing_account_conflict` (409) and
  `billing_portal_unavailable` (503).

Fixes:

- `cashsdk-web`: a request that gets no response (offline, DNS, a refused or reset connection)
  fails with the new code `network_error` (status 0, retryable) instead of a raw fetch
  `TypeError`. The original error is its `cause`. `waitForCheckout` and `waitForEntitlement` now
  keep reading through it until their deadline, and still stop at once on an abort, a sign-out
  or a customer change. Timeouts are still `timeout`.
- `cashsdk-react`: hooks report it as their `error`. After a failed first load,
  `useEntitlements().refresh()` loads the customer and access again instead of leaving the
  state in `error`.
- `cashsdk-node`: network failures are `network_error` too.

## 0.1.0-alpha.0

First preview.

- `cashsdk-web`: customer sessions from your backend, access, subscriptions, offerings,
  Stripe hosted checkout with idempotent retries, `waitForCheckout` and `waitForEntitlement`
  for the return page, typed errors with stable codes and request ids.
- `cashsdk-react`: `CashSDKProvider`, `useCustomer`, `useEntitlements`, `useSubscriptions`,
  `useOfferings`, `useCheckout`. Safe in server rendering and in Strict Mode.
- `cashsdk-node`: `createWebSession`, `revokeWebSessions`, `getEntitlements`, `verifyWebhook`.
