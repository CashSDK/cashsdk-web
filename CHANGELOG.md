# Changelog

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
