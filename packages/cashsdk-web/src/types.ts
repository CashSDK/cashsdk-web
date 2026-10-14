import type { CashSDKError } from "./http.js";

export type Environment = "sandbox" | "production";
export interface RequestOptions {
  signal?: AbortSignal;
}
/**
 * What `createWebSession` in `cashsdk-node` returns. Pass it on as it is: the SDK reads
 * `expiresInSeconds` on this device's clock, so a clock that is off does not matter. A
 * provider that returns only `expiresAt` still works.
 */
export interface SessionToken {
  token: string;
  /** Seconds the session is valid for, counted from when your backend answered. */
  expiresInSeconds?: number;
  /** When the session ends, on the server's clock. */
  expiresAt?: string;
}
export type SessionTokenProvider = (options: {
  signal: AbortSignal;
}) => Promise<string | SessionToken>;
/**
 * Where `purchase` keeps its attempts: one idempotency key and checkout id per customer and
 * package. Each method may return a promise. The default is the tab's `sessionStorage`, or
 * memory when storage is blocked. In an extension service worker, pass `chrome.storage.local`.
 */
export interface PurchaseStorage {
  get(key: string): string | null | undefined | Promise<string | null | undefined>;
  set(key: string, value: string): void | Promise<void>;
  remove(key: string): void | Promise<void>;
}
export interface CashSDKOptions {
  publishableKey: string;
  environment: Environment;
  getSessionToken: SessionTokenProvider;
  apiUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Where `purchase` keeps its attempts. The tab's `sessionStorage` by default. */
  purchaseStorage?: PurchaseStorage;
}
export interface Customer {
  customerId: string;
  environment: Environment;
}
export interface Entitlement {
  identifier: string;
  name: string;
  active: boolean;
  rank: number | null;
  source: string;
  expiresAt?: string | null;
}
export interface EntitlementSnapshot extends Customer {
  revision: number;
  computedAt: string;
  entitlements: readonly Entitlement[];
}
export interface WebSubscription {
  productIdentifier: string;
  displayName: string | null;
  /** stripe, app-store, play-store and so on. */
  provider: string | null;
  /** The stored state, for example active, expired or revoked. */
  status: string;
  /** Whether it grants access right now. */
  active: boolean;
  expiresAt: string | null;
  /** False once the customer has turned renewal off. */
  autoRenew: boolean;
  trial: boolean;
}
export interface Subscriptions extends Customer {
  subscriptions: readonly WebSubscription[];
}
export interface WebPackage {
  id: string;
  identifier: string;
  product: {
    identifier: string;
    displayName: string | null;
    /** auto_renewable, non_consumable and so on. */
    type: string;
    provider: string;
    amountMinor: string | null;
    currency: string | null;
    duration: string | null;
  };
  /**
   * This session can start a checkout for it. False when the customer already has this
   * plan's access or owns the one-time product.
   */
  purchasable: boolean;
}
export interface Offerings {
  current: {
    id: string;
    identifier: string;
    displayName: string | null;
    packages: readonly WebPackage[];
  } | null;
}
export interface CheckoutInput {
  packageId: string;
  /** Optional. Without it CashSDK uses the app's active connection for the package's provider. */
  connectionId?: string;
  successUrl: string;
  cancelUrl: string;
}
export interface CheckoutOptions extends RequestOptions {
  idempotencyKey: string;
}
export interface Checkout {
  id: string;
  provider: "stripe";
  environment: Environment;
  /** The customer the checkout belongs to. Older servers leave it out. */
  customerId?: string;
  /** "subscription" for a recurring plan, "payment" for a one-time product. */
  mode?: "subscription" | "payment";
  /** The catalog product being bought. */
  productIdentifier?: string;
  /**
   * A status this SDK version does not know reads as `pending`: keep the attempt and read
   * it again.
   */
  status:
    | "pending"
    | "requires_action"
    | "complete"
    | "expired"
    | "failed"
    | "needs_review";
  paymentStatus: string | null;
  accessStatus: "check_entitlements";
  action: { type: "redirect"; url: string } | null;
  expiresAt: string | null;
}
export interface PurchaseInput extends RequestOptions {
  /** Where Stripe sends the customer after paying. On the session's origin, no fragment. */
  successUrl: string;
  /** Where Stripe sends the customer who leaves. On the session's origin, no fragment. */
  cancelUrl: string;
  /** Optional. Without it CashSDK uses the app's active connection for the package's provider. */
  connectionId?: string;
}
export interface BillingPortalInput {
  /** Where Stripe sends the customer back. On the session's origin, with no fragment. */
  returnUrl: string;
}
export interface BillingPortal {
  /**
   * Stripe's customer portal for the signed-in customer. It expires within minutes, so
   * send the customer there at once and ask for a new one next time.
   */
  url: string;
}
export interface WaitOptions extends RequestOptions {
  /** Stop waiting after this long. 30 seconds by default, 5 minutes at most. */
  timeoutMs?: number;
  /** Delay before the second read, 1000 to 5000. It grows by half each time, up to 5 seconds. */
  intervalMs?: number;
}
export interface CheckoutOutcome {
  checkout: Checkout;
  /**
   * False when the wait ended while the checkout was still open or its payment still
   * unsettled. That is not a failed payment. Read the checkout again later.
   */
  settled: boolean;
}
export interface EntitlementOutcome {
  snapshot: EntitlementSnapshot;
  /** False when the wait ended before the entitlement was active. */
  active: boolean;
}
export interface RevocationResult {
  /** True when CashSDK confirmed the session ended (or had already), or this client held none. */
  revoked: boolean;
  /** Why CashSDK could not be told, when `revoked` is false. */
  error: CashSDKError | null;
}
export interface LogoutResult {
  /**
   * Ending this tab's session at CashSDK. It runs on its own and never rejects. Your
   * backend's `revokeWebSessions` ends every session of the customer either way.
   */
  revocation: Promise<RevocationResult>;
}
export interface ClientSnapshot {
  status: "idle" | "loading" | "ready" | "error" | "signed_out" | "destroyed";
  customer: Customer | null;
  entitlements: EntitlementSnapshot | null;
  error: CashSDKError | null;
}
