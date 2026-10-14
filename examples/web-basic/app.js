import { createCashSDK } from "/sdk/index.js";

const element = (id) => document.getElementById(id);
const message = (text) => {
  element("message").textContent = text;
};
const configuration = await fetch("/configuration").then((response) =>
  response.json(),
);
const getSessionToken = async ({ signal }) => {
  const response = await fetch("/api/cashsdk/session", {
    method: "POST",
    credentials: "same-origin",
    signal,
  });
  if (!response.ok) throw new Error("Sign in to load CashSDK access");
  return response.json();
};
const cashsdk = createCashSDK({
  publishableKey: configuration.publishableKey,
  environment: "sandbox",
  apiUrl: configuration.apiUrl,
  getSessionToken,
});
const checkoutRows = new Set();
// The entitlement this example sells. The server checks the same one.
const entitlement = "pro";
// One follower per page load. Signing out or loading again ends the previous one.
let following = new AbortController();
let signingOut = false;
let loading = false;

const showSignedOut = (text) => {
  following.abort();
  element("account").hidden = true;
  element("login").hidden = false;
  checkoutRows.clear();
  if (text) message(text);
};
cashsdk.subscribe(() => {
  const state = cashsdk.getSnapshot();
  element("access").textContent = JSON.stringify(state.entitlements, null, 2);
  if (element("account").hidden || signingOut) return;
  // Another tab signed out: this one drops the account at once.
  if (state.status === "signed_out") showSignedOut("Signed out in another tab.");
  // Another tab signed someone in: load whoever the backend signs in now.
  else if (state.status === "idle" && !loading)
    void load().catch(() => showSignedOut("Sign in to load CashSDK access"));
});

async function load() {
  loading = true;
  try {
    await cashsdk.initialize();
  } finally {
    loading = false;
  }
  element("account").hidden = false;
  element("login").hidden = true;
  const offerings = await cashsdk.getOfferings();
  checkoutRows.clear();
  following.abort();
  following = new AbortController();
  const { signal } = following;
  element("packages").replaceChildren();
  for (const pkg of offerings.current?.packages ?? []) {
    const row = document.createElement("div");
    const label = document.createElement("p");
    label.textContent = `${pkg.product.displayName ?? pkg.identifier}: ${pkg.product.amountMinor ?? "unknown"} minor units ${pkg.product.currency ?? ""}`;
    const button = document.createElement("button");
    const status = document.createElement("p");
    // The server says whether this customer can buy it: false once they have the plan.
    const unavailable = !pkg.purchasable || pkg.product.provider !== "stripe";
    let lastCheckout = null;
    const present = (checkout) => {
      lastCheckout = checkout;
      button.disabled =
        unavailable || ["complete", "needs_review"].includes(checkout?.status);
      if (!checkout) {
        status.textContent = "";
        button.textContent = "Start sandbox checkout";
        return;
      }
      status.textContent = `Checkout: ${checkout.status}; payment: ${checkout.paymentStatus ?? "pending"}. Access is checked separately.`;
      button.textContent =
        checkout.status === "requires_action"
          ? "Resume checkout"
          : ["expired", "failed"].includes(checkout.status)
            ? "Start a new checkout"
            : "Retry this checkout";
    };
    present(null);
    // After the return from the provider, the payment and then the access arrive on their
    // own. Follow both for a bounded time instead of asking the customer to refresh.
    const follow = async () => {
      const open =
        ["pending", "requires_action"].includes(lastCheckout?.status) ||
        (lastCheckout?.status === "complete" &&
          lastCheckout.paymentStatus === "unpaid");
      if (!open) return;
      const outcome = await cashsdk.waitForPurchase(pkg.id, {
        signal,
        timeoutMs: 60000,
      });
      if (!outcome) return;
      present(outcome.checkout);
      if (!outcome.settled || outcome.checkout.status !== "complete") return;
      message("Payment confirmed. Waiting for access.");
      const access = await cashsdk.waitForEntitlement(entitlement, {
        signal,
        timeoutMs: 60000,
      });
      message(
        access.active
          ? "Access granted."
          : "The payment is confirmed and access has not arrived yet. Refresh access in a moment.",
      );
    };
    // The customer's attempt for this package, if one is under way. The SDK keeps its key
    // and checkout id in this tab's sessionStorage, and forgets an attempt once it is over.
    const refreshCheckout = async () => present(await cashsdk.getPurchase(pkg.id));
    checkoutRows.add(refreshCheckout);
    try {
      await refreshCheckout();
      // Not awaited: the page stays usable while the payment is followed.
      void follow().catch(() => {
        /* Signed out, left the page, or unreachable. The Refresh button still works. */
      });
    } catch {
      status.textContent =
        "Unable to refresh checkout status. Retry uses the same purchase attempt.";
    }
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        // One key per customer and package, saved before the request: a retry, a lost answer
        // or a reload is the same purchase. A finished attempt makes room for a new one.
        const checkout = await cashsdk.purchase(pkg.id, {
          // Optional: without it CashSDK routes to the app's active connection.
          ...(configuration.connectionId
            ? { connectionId: configuration.connectionId }
            : {}),
          successUrl: location.origin,
          cancelUrl: location.origin,
        });
        present(checkout);
        if (checkout.action) location.assign(checkout.action.url);
        else if (checkout.status === "complete")
          message("This purchase is complete. Access follows from the payment.");
        else
          message(
            `Checkout ${checkout.status}. Retry this same button if the operation is pending.`,
          );
      } catch (error) {
        // already_subscribed, already_owned and already_purchased: access follows, or is there.
        message(error.message);
      } finally {
        button.disabled =
          unavailable ||
          ["complete", "needs_review"].includes(lastCheckout?.status);
      }
    });
    row.append(label, status, button);
    element("packages").append(row);
  }
  message(
    "Access loaded from CashSDK. Returning from checkout does not itself grant access.",
  );
}

element("login").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const response = await fetch("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: element("password").value }),
    });
    element("password").value = "";
    if (!response.ok) throw new Error((await response.json()).message);
    cashsdk.setSessionTokenProvider(getSessionToken);
    await load();
  } catch (error) {
    message(error.message);
  }
});
element("refresh").addEventListener("click", async () => {
  try {
    await Promise.all([...checkoutRows].map((refresh) => refresh()));
    await cashsdk.refreshEntitlements();
    message("Access refreshed");
  } catch (error) {
    message(error.message);
  }
});
element("protected").addEventListener("click", async () => {
  try {
    const response = await fetch("/api/protected", { method: "POST" });
    message((await response.json()).message);
  } catch {
    message("The backend is unavailable");
  }
});
element("logout").addEventListener("click", async () => {
  signingOut = true;
  // Local access is cleared at once, here and in the customer's other tabs.
  const { revocation } = await cashsdk.logout();
  showSignedOut();
  // The backend's sign-out ends every CashSDK session of the customer. It does not wait for
  // this tab's own revocation.
  const [ended, backend] = await Promise.all([
    revocation,
    fetch("/logout", { method: "POST" }).then(
      (response) => response.ok,
      () => false,
    ),
  ]);
  signingOut = false;
  message(
    !backend
      ? "The backend could not complete sign-out. Retry when it is available."
      : ended.revoked
        ? "Signed out."
        : "Signed out. CashSDK was not reached; the backend ended the session.",
  );
});
try {
  await load();
} catch {
  message("Sign in with the password configured on the local example server.");
}
