import { CashSDKClient, CashSDKError } from "./index.js";
import type { BillingPortal, CashSDKOptions, Checkout } from "./types.js";

/** The small subset of Chrome APIs used here. No dependency on Chrome's type package. */
export interface ExtensionRuntime {
  id?: string;
  getURL(path: string): string;
}
export interface ExtensionTabs {
  create(properties: { url: string; active: boolean }): Promise<unknown>;
}

export function extensionOrigin(runtime: ExtensionRuntime): string {
  const id = runtime.id;
  if (
    !id ||
    !/^[a-p]{32}$/.test(id) ||
    runtime.getURL("") !== `chrome-extension://${id}/`
  ) {
    throw new CashSDKError(
      "invalid_configuration",
      "Run this client in your Chrome extension, not in a content script",
    );
  }
  return `chrome-extension://${id}`;
}

/**
 * MV3 popup, side panel and service-worker client. Bundle this module in the extension.
 * Pass chrome.runtime explicitly; importing it never accesses browser globals or storage.
 * Obtain tokens from an authenticated merchant backend, never from content-script messages.
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

/** Open only a validated Stripe action in a tab. Returning here does not grant access. */
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
  await openStripeTab(tabs, checkout.action.url, "checkout.stripe.com");
}

export async function openBillingPortalTab(
  tabs: ExtensionTabs,
  portal: BillingPortal,
): Promise<void> {
  await openStripeTab(tabs, portal.url, "billing.stripe.com");
}

async function openStripeTab(
  tabs: ExtensionTabs,
  value: string,
  host: string,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CashSDKError("invalid_response", "Invalid Stripe URL");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== host ||
    url.port ||
    url.username ||
    url.password
  ) {
    throw new CashSDKError("invalid_response", "Invalid Stripe URL");
  }
  await tabs.create({ url: url.href, active: true });
}
