# Web example

A complete browser and Node.js application built on the three packages: a sign-in, a CashSDK
session endpoint, access, subscriptions, Stripe checkout with recovery after the redirect, a
protected resource checked on the server, and sign-out.

The sign-in is a local stand-in with one password and one customer. The server binds to
loopback and refuses to start with `NODE_ENV=production`. Use your own authentication in a
real application.

1. In the CashSDK dashboard, create a Web app, allow `http://localhost:3000` as a sandbox origin,
   and create a restricted sandbox key with **Create customer web sessions** and **Customers**
   read. For checkout, connect Stripe in sandbox and add a Stripe product to the current offering.
2. From the repository root: `pnpm install && pnpm build`.
3. Start it:

   ```sh
   EXAMPLE_PASSWORD='a local password of 16+ characters' \
   EXAMPLE_CUSTOMER_ID=example_customer \
   CASHSDK_PUBLISHABLE_KEY=csk_pk_… \
   CASHSDK_SECRET_KEY=csk_rk_test_… \
   node examples/web-basic/server.mjs
   ```

4. Open `http://localhost:3000`.

The browser never sees the secret key or picks its customer. The session endpoint runs after
the sign-in, and the protected resource asks CashSDK again on the server. Each checkout attempt
keeps its idempotency key in this tab's session storage, so a retry after a redirect or a lost
response is the same purchase. After the return from Stripe the page waits for the payment and
the access with `waitForCheckout` and `waitForEntitlement`.
