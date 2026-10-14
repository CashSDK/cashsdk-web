# Chrome extension with your own Stripe account

An unpacked Manifest V3 example using `cashsdk-web/extension`. Build from the repository
root:

```sh
pnpm --filter cashsdk-web build
node examples/chrome-extension/build.mjs
```

Load this directory from `chrome://extensions`, Developer mode, Load unpacked. Open
the popup and copy the displayed extension origin into the app's allowed origins.
Also allow the hosted checkout return origin. Select Chrome extension as an app platform.

Connect your Stripe account, import and map your prices, create an offering and
activate the connection. Start in Sandbox. For a Chrome Web Store build, allow its
extension ID under Production origins.

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

Buy opens a Stripe tab. Refresh access after payment. The worker buys with
`purchase`, which keeps one idempotency key and checkout id per customer and package in
`chrome.storage.local` (the `purchaseStorage` option), saved before checkout and again
before the tab opens. Closing the popup or terminating the worker does not lose the
attempt: buying again resumes the same checkout. Each package has its own attempt, and an
attempt that is over (paid, expired, refused, or one the customer already owns) is
forgotten, so the next purchase starts a new one. Content scripts and external senders
cannot invoke the worker's commands, and the SDK refuses to run in a content script.
Billing portal actions are owner-checked on the backend. Sign-out clears local access at
once and does not wait for CashSDK.

Documentation: https://docs.cashsdk.com/sdk/chrome-extension. The entry point ships in
the `cashsdk-web` npm package. Before you publish to the Chrome Web Store, follow
https://docs.cashsdk.com/sdk/go-live.
