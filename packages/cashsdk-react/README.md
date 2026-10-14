# cashsdk-react

React 18 and 19 bindings for [`cashsdk-web`](https://www.npmjs.com/package/cashsdk-web). Version
`1.0.0` is generally available on npm. `cashsdk-web` is a peer dependency: install the
same version of both, so your app and the bindings share one copy.

```sh
npm install cashsdk-web@1.0.0 cashsdk-react@1.0.0
```

Create one client outside your components, then provide it.

```tsx
import { createCashSDK } from "cashsdk-web";
import { CashSDKProvider, useEntitlements } from "cashsdk-react";

const cashsdk = createCashSDK({
  publishableKey: "csk_pk_…",
  environment: "sandbox",
  getSessionToken: async ({ signal }) => {
    const response = await fetch("/api/cashsdk/session", { method: "POST", signal });
    if (!response.ok) throw new Error("Sign in to continue");
    return response.json();
  },
});

function AccessStatus() {
  const { status, error, isActive } = useEntitlements();
  if (error?.code === "session_unavailable") return <p>Sign in to see your plan.</p>;
  if (error) return <p role="alert">Could not load access.</p>;
  if (status !== "ready") return <p>Loading access...</p>;
  return <p>{isActive("pro") ? "Pro is active" : "Choose a plan"}</p>;
}

export function App() {
  return <CashSDKProvider client={cashsdk}><AccessStatus /></CashSDKProvider>;
}
```

## Hooks

| Hook | Returns |
| --- | --- |
| `useCustomer()` | `customer`, `status`, `error` |
| `useEntitlements()` | `snapshot`, `status`, `error`, `isActive(id)`, `refresh()` |
| `useSubscriptions()` | `subscriptions`, `status`, `error`, `refresh()` |
| `useOfferings()` | `offerings`, `status`, `error`, `refresh()` |
| `usePurchase()` | `start(packageId, { successUrl, cancelUrl })`, `checkout`, `status`, `error`, `reset()` |
| `useCheckout()` | `start(input, { idempotencyKey })`, `checkout`, `status`, `error`, `reset()`. Prefer `usePurchase` |
| `useBillingPortal()` | `start({ returnUrl })`, `portal`, `status`, `error`, `reset()` |
| `useCashSDK()` / `useCashSDKState()` | the client, and its whole snapshot |

Every `error` is a `CashSDKError`: decide on `error.code`. A lost connection is `network_error`
with `retryable: true`; offer a retry that calls `refresh()`. A failing `getSessionToken` (nobody is
signed in) is `session_unavailable`. After a failed first load, `useEntitlements().refresh()` loads
the customer and access again.

```tsx
import { useOfferings, usePurchase } from "cashsdk-react";

export function Plans() {
  const { offerings, status } = useOfferings();
  const purchase = usePurchase();
  if (status !== "ready") return <p>Loading plans...</p>;
  return (
    <>
      {offerings?.current?.packages.map((item) => (
        <button key={item.id} disabled={!item.purchasable || purchase.status === "starting"}
          onClick={async () => {
            const checkout = await purchase.start(item.id, {
              successUrl: `${location.origin}/billing/return?package=${encodeURIComponent(item.id)}`,
              cancelUrl: `${location.origin}/pricing`,
            });
            if (checkout.action) location.assign(checkout.action.url);
          }}>
          {item.product.displayName ?? item.identifier}
        </button>
      ))}
      {purchase.error?.code === "already_subscribed" && <p>You already have this plan.</p>}
      {purchase.checkout?.status === "complete" && <p>Paid. Your access arrives in a moment.</p>}
    </>
  );
}
```

`usePurchase` keeps one idempotency key per customer and package for you, and starts a new one
once an attempt is over, so buying a plan a second time works. A double click is one purchase; a
click on another package while one is starting is refused with `purchase_in_progress`. On the
return page, `useCashSDK().waitForPurchase(packageId)` waits for the payment, then
`waitForEntitlement` for the access.

Reads follow the signed-in customer: a result read for one customer is never shown for the next,
and `usePurchase`, `useCheckout` and `useBillingPortal` drop the previous customer's result and
error when the customer changes. `start` belongs in a click or submit handler, never in an effect.

```tsx
import { useBillingPortal } from "cashsdk-react";

export function ManageBilling() {
  const portal = useBillingPortal();
  return (
    <>
      <button disabled={portal.status === "starting"}
        onClick={async () => {
          const { url } = await portal.start({ returnUrl: `${location.origin}/account` });
          location.assign(url);
        }}>
        Manage billing
      </button>
      {portal.error?.code === "no_billing_account" && <p>You have no paid plan yet.</p>}
    </>
  );
}
```

The session needs the `billing:manage` scope.

Works with the Next.js App Router: the package is marked `"use client"`, server rendering shows an
empty state and makes no request, and Strict Mode does not duplicate anything. The provider does
not dispose the client: call `logout` on sign-out and `destroy` when you are done with it. When
another tab of your app signs out, this one is signed out too; when another tab signs someone in,
the provider loads them. ES modules only, like `cashsdk-web`.

Guide: [docs.cashsdk.com/sdk/web](https://docs.cashsdk.com/sdk/web). License: MIT.
