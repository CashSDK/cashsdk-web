# Chrome extension with your own Stripe account

An unpacked Manifest V3 example using `cashsdk-web/extension` from the alpha.2 preview.
Build from the repository root:

```sh
pnpm --filter cashsdk-web build
node examples/chrome-extension/build.mjs
```

Load this directory from `chrome://extensions`, Developer mode, Load unpacked. Open
the popup and copy the displayed extension origin into the app's allowed origins.
Also allow the hosted checkout return origin. Select Chrome extension as an app platform.

Connect your Stripe account, import and map recurring prices, create an offering and
activate the connection. SDK-created checkout requires the sandbox preview flag on both
CashSDK services. The example does not enable production checkout.

Your backend session endpoint must authenticate a merchant session bearer token and
return the `cashsdk-node` `createWebSession` response with the authenticated customer's
ID, the configured extension origin, and these scopes: `customer:read`,
`entitlements:read`, `subscriptions:read`, `offerings:read`, `checkout:create`,
`checkout:read`, `billing:manage`. Return `Cache-Control: no-store`. The endpoint must
not trust a customer ID or origin passed in a request. Sign out on your backend by
revoking all CashSDK sessions for that customer as well.

Enter that endpoint, the CashSDK API origin and publishable key, hosted return URL and
your signed-in merchant bearer token in the popup. Host permissions are requested only
for the two configured hosts. The bearer token lives in `chrome.storage.session` until
sign-out or browser exit, and is not exposed to content scripts. Stripe and CashSDK
server keys never belong here.

Buy opens a Stripe tab. Refresh access after payment. The worker saves its idempotency
key before checkout and saves the returned checkout ID. Closing the popup or terminating
the worker does not lose the attempt. Content scripts and external senders cannot invoke
the worker's commands. Billing portal actions are owner-checked on the backend.

Documentation: https://docs.cashsdk.com/sdk/chrome-extension. This source entry point
has not been published to npm. A real Stripe sandbox payment and a Chrome Web Store
submission remain separate from the automated integration tests.
