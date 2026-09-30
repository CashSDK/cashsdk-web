# cashsdk-react

React 18 and 19 bindings for [`cashsdk-web`](https://www.npmjs.com/package/cashsdk-web). Version
`0.1.0-alpha.0` is a preview on the `next` tag.

```sh
npm install cashsdk-web@next cashsdk-react@next
```

Create one client outside your components, then provide it.

```tsx
import { createCashSDK } from "cashsdk-web";
import { CashSDKProvider, useEntitlements } from "cashsdk-react";

const cashsdk = createCashSDK({ publishableKey: "csk_pk_…", environment: "sandbox", getSessionToken });

function AccessStatus() {
  const { status, error, isActive } = useEntitlements();
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
| `useCheckout()` | `start(input, options)`, `checkout`, `status`, `error`, `reset()` |
| `useCashSDK()` / `useCashSDKState()` | the client, and its whole snapshot |

```tsx
function Plans() {
  const { offerings, status } = useOfferings();
  const checkout = useCheckout();
  const [attempt] = useState(() => crypto.randomUUID());
  if (status !== "ready") return <p>Loading plans...</p>;
  return offerings?.current?.packages.map((item) => (
    <button key={item.id} disabled={!item.purchasable || checkout.status === "starting"}
      onClick={async () => {
        const result = await checkout.start(
          { packageId: item.id, successUrl: `${location.origin}/return`, cancelUrl: `${location.origin}/pricing` },
          { idempotencyKey: attempt },
        );
        if (result.action?.type === "redirect") location.assign(result.action.url);
      }}>
      {item.product.displayName}
    </button>
  ));
}
```

Reads follow the signed-in customer: a result read for one customer is never shown for the next.
`start` belongs in a click or submit handler, never in an effect; a double click is one request.

Works with the Next.js App Router: the package is marked `"use client"`, server rendering shows an
empty state and makes no request, and Strict Mode does not duplicate anything. The provider does
not dispose the client: call `logout` on sign-out and `destroy` when you are done with it.

Guide: [docs.cashsdk.com/sdk/web](https://docs.cashsdk.com/sdk/web). License: MIT.
