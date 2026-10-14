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
const attemptPrefix = "cashsdk.example.checkout:";
const checkoutRows = new Set();
// The entitlement this example sells. The server checks the same one.
const entitlement = "pro";
// One follower per page load. Signing out or loading again ends the previous one.
let following = new AbortController();
cashsdk.subscribe(() => {
  element("access").textContent = JSON.stringify(
    cashsdk.getSnapshot().entitlements,
    null,
    2,
  );
});

async function load() {
  await cashsdk.initialize();
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
    button.textContent = "Start sandbox checkout";
    const unavailable =
      !pkg.purchasable ||
      pkg.product.provider !== "stripe" ||
      pkg.product.type !== "auto_renewable";
    button.disabled = unavailable;
    const status = document.createElement("p");
    const customerId = cashsdk.getSnapshot().customer.customerId;
    const attemptKey = `${attemptPrefix}${JSON.stringify([configuration.publishableKey, customerId, configuration.connectionId, pkg.id])}`;
    let attempt = null;
    let lastCheckout = null;
    // An expired or refused attempt is over. The next one is a new purchase, with a new key.
    const over = (result) => ["expired", "failed"].includes(result?.status);
    const present = (result) => {
      lastCheckout = result;
      status.textContent = `Checkout: ${result.status}; payment: ${result.paymentStatus ?? "pending"}. Access is checked separately.`;
      button.disabled =
        unavailable || ["complete", "needs_review"].includes(result.status);
      button.textContent = over(result)
        ? "Start a new checkout"
        : result.status === "requires_action"
          ? "Resume checkout"
          : "Retry this checkout";
    };
    // After the return from the provider, the payment and then the access arrive on their
    // own. Follow both for a bounded time instead of asking the customer to refresh.
    const follow = async () => {
      if (!attempt?.id || !lastCheckout) return;
      const open =
        ["pending", "requires_action"].includes(lastCheckout.status) ||
        (lastCheckout.status === "complete" &&
          lastCheckout.paymentStatus === "unpaid");
      if (!open) return;
      const outcome = await cashsdk.waitForCheckout(attempt.id, {
        signal,
        timeoutMs: 60000,
      });
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
    try {
      const stored = sessionStorage.getItem(attemptKey);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (
          !/^[A-Za-z0-9_-]{16,128}$/.test(parsed.key) ||
          (parsed.id && !/^[A-Za-z0-9_-]{1,200}$/.test(parsed.id))
        )
          throw new Error("Invalid saved checkout attempt");
        attempt = parsed;
      }
    } catch {
      button.disabled = true;
      status.textContent =
        "Checkout requires readable session storage to preserve its retry key across redirects.";
    }
    const refreshCheckout = async () => {
      if (attempt?.id) present(await cashsdk.getCheckout(attempt.id));
    };
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
        if (
          lastCheckout?.status === "requires_action" &&
          lastCheckout.action?.type === "redirect"
        ) {
          location.assign(lastCheckout.action.url);
          return;
        }
        if (!attempt || over(lastCheckout))
          attempt = { key: crypto.randomUUID() };
        // Persist the operation key before sending. Only operation IDs and retry keys are saved.
        sessionStorage.setItem(attemptKey, JSON.stringify(attempt));
        const result = await cashsdk.checkout(
          {
            packageId: pkg.id,
            // Optional: without it CashSDK routes to the app's active connection.
            ...(configuration.connectionId
              ? { connectionId: configuration.connectionId }
              : {}),
            successUrl: location.origin,
            cancelUrl: location.origin,
          },
          { idempotencyKey: attempt.key },
        );
        attempt.id = result.id;
        sessionStorage.setItem(attemptKey, JSON.stringify(attempt));
        present(result);
        if (result.action?.type === "redirect")
          location.assign(result.action.url);
        else
          message(
            `Checkout ${result.status}. Retry this same button if the operation is pending.`,
          );
      } catch (error) {
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
  try {
    await cashsdk.logout();
  } catch {
    message("Remote revocation was unavailable. Local access was cleared.");
  } finally {
    following.abort();
    element("account").hidden = true;
    element("login").hidden = false;
    checkoutRows.clear();
    try {
      await fetch("/logout", { method: "POST" });
    } catch {
      message(
        "The backend could not complete sign-out. Retry when it is available.",
      );
    }
  }
});
try {
  await load();
} catch {
  message("Sign in with the password configured on the local example server.");
}
