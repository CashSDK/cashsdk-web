import { CashSDKClient, CashSDKError } from "./index.js";
import { stripePageUrl } from "./http.js";
import type { BillingPortal, CashSDKOptions, Checkout } from "./types.js";

/** The small subset of Chrome APIs used here. No dependency on Chrome's type package. */
export interface ExtensionRuntime {
  id?: string;
  getURL(path: string): string;
}
export interface ExtensionTabs {
  create(properties: { url: string; active: boolean }): Promise<unknown>;
}

/**
 * The extension's own origin, `chrome-extension://<id>`. It throws in a content script:
 * one runs on the web page's origin, even though it can read `chrome.runtime`. Where no
 * `location` exists (a test runner), only the runtime is checked.
 */
export function extensionOrigin(runtime: ExtensionRuntime): string {
  const id = runtime?.id;
  const origin = `chrome-extension://${id}`;
  const location = (globalThis as { location?: { origin?: unknown } }).location;
  if (
    !id ||
    !/^[a-p]{32}$/.test(id) ||
    runtime.getURL("") !== `${origin}/` ||
    (location !== undefined && location?.origin !== origin)
  ) {
    throw new CashSDKError(
      "invalid_configuration",
      "Create the client in an extension page or the service worker, never in a content script",
    );
  }
  return origin;
}

/**
 * MV3 popup, side panel and service-worker client. Bundle this module in the extension.
 * Pass chrome.runtime explicitly; importing it never accesses browser globals or storage.
 * Obtain tokens from an authenticated merchant backend, never from content-script messages.
 * A service worker has no sessionStorage: pass `purchaseStorage` backed by
 * `chrome.storage.local` so purchase attempts survive the worker stopping.
 */
export function createExtensionCashSDK(
  options: CashSDKOptions & { runtime: ExtensionRuntime },
): CashSDKClient {
  const origin = extensionOrigin(options.runtime);
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);
  return new CashSDKClient({
    ...options,
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("X-CashSDK-Client-Origin", origin);
      return send(input, { ...init, headers });
    },
  });
}

/**
 * Open a checkout's Stripe page in a new tab: Stripe's own host or the account's custom
 * domain. Only a checkout that waits for the customer has one. Returning here grants nothing.
 */
export async function openCheckoutTab(
  tabs: ExtensionTabs,
  checkout: Checkout,
): Promise<void> {
  if (
    checkout.status !== "requires_action" ||
    checkout.action?.type !== "redirect"
  ) {
    throw new CashSDKError(
      "checkout_not_ready",
      "Read checkout status before opening payment",
    );
  }
  await openStripeTab(tabs, stripePageUrl(checkout.action.url, "checkout"));
}

/** Open a customer portal session in a new tab: Stripe's own host or the custom domain. */
export async function openBillingPortalTab(
  tabs: ExtensionTabs,
  portal: BillingPortal,
): Promise<void> {
  await openStripeTab(tabs, stripePageUrl(portal?.url, "portal"));
}

async function openStripeTab(
  tabs: ExtensionTabs,
  url: string | null,
): Promise<void> {
  if (!url) throw new CashSDKError("invalid_response", "Invalid Stripe URL");
  await tabs.create({ url, active: true });
}
