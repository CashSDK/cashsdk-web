export type Environment = "sandbox" | "production";
export interface RequestOptions {
  signal?: AbortSignal;
}
export interface SessionToken {
  token: string;
  expiresAt?: string;
}
export type SessionTokenProvider = (options: {
  signal: AbortSignal;
}) => Promise<string | SessionToken>;
export interface CashSDKOptions {
  publishableKey: string;
  environment: Environment;
  getSessionToken: SessionTokenProvider;
  apiUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
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
    type: string;
    provider: string;
    amountMinor: string | null;
    currency: string | null;
    duration: string | null;
  };
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
  /** Delay before the second read. It grows by half each time, up to 5 seconds. */
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
export interface ClientSnapshot {
  status: "idle" | "loading" | "ready" | "error" | "signed_out" | "destroyed";
  customer: Customer | null;
  entitlements: EntitlementSnapshot | null;
  error: Error | null;
}
