# Changelog

## 0.1.0-alpha.0

First preview.

- `cashsdk-web`: customer sessions from your backend, access, subscriptions, offerings,
  Stripe hosted checkout with idempotent retries, `waitForCheckout` and `waitForEntitlement`
  for the return page, typed errors with stable codes and request ids.
- `cashsdk-react`: `CashSDKProvider`, `useCustomer`, `useEntitlements`, `useSubscriptions`,
  `useOfferings`, `useCheckout`. Safe in server rendering and in Strict Mode.
- `cashsdk-node`: `createWebSession`, `revokeWebSessions`, `getEntitlements`, `verifyWebhook`.
