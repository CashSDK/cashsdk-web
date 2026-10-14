import {
  aborted,
  apiUrl,
  CashSDKError,
  isCashSDKError,
  networkError,
  responseError,
  responseJSON,
  responseText,
  stripePageUrl,
  toCashSDKError,
  withAbort,
} from "./http.js";
import {
  attemptKey,
  attemptSlot,
  clearAttempt,
  FINAL_REFUSALS,
  isOver,
  readAttempt,
  tabStorage,
  writeAttempt,
  type Attempt,
} from "./purchase.js";
import type {
  BillingPortal,
  BillingPortalInput,
  CashSDKOptions,
  Checkout,
  CheckoutInput,
  CheckoutOptions,
  CheckoutOutcome,
  ClientSnapshot,
  Customer,
  EntitlementOutcome,
  EntitlementSnapshot,
  LogoutResult,
  Offerings,
  PurchaseInput,
  PurchaseStorage,
  RequestOptions,
  RevocationResult,
  SessionToken,
  SessionTokenProvider,
  Subscriptions,
  WaitOptions,
} from "./types.js";
export { CashSDKError } from "./http.js";
export type * from "./types.js";

const initial = (): ClientSnapshot =>
  Object.freeze({
    status: "idle",
    customer: null,
    entitlements: null,
    error: null,
  });

/** The longest session CashSDK issues. A token is never reused for longer. */
const MAX_SESSION_MS = 600_000;
/** How long a session with no usable expiry is reused before the backend is asked again. */
const SHORT_SESSION_MS = 60_000;
const STATUSES = new Set<string>([
  "pending",
  "requires_action",
  "complete",
  "expired",
  "failed",
  "needs_review",
]);

/**
 * When to stop reusing a session, on this device's clock. `expiresInSeconds` is relative,
 * so a clock that is off does not matter. An absolute `expiresAt` that this clock already
 * sees as past (a clock running ahead) is used for a short while anyway: CashSDK's 401 is
 * what ends a session, and the SDK then asks for a new one. Null when the provider says the
 * session has already ended.
 */
function sessionExpiry(result: SessionToken, receivedAt: number): number | null {
  if (result.expiresInSeconds !== undefined && result.expiresInSeconds !== null) {
    const seconds = result.expiresInSeconds;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0)
      return null;
    return receivedAt + Math.min(seconds * 1000, MAX_SESSION_MS);
  }
  if (result.expiresAt === undefined || result.expiresAt === null)
    return receivedAt + SHORT_SESSION_MS;
  const at =
    typeof result.expiresAt === "string" ? Date.parse(result.expiresAt) : NaN;
  if (!Number.isFinite(at)) return null;
  const left = at - receivedAt;
  return receivedAt + (left > 0 ? Math.min(left, MAX_SESSION_MS) : SHORT_SESSION_MS);
}

type Broadcast =
  | { type: "signed_out"; customerId: string | null }
  | { type: "customer_changed" };

/**
 * Tabs of one app (one publishable key and environment) tell each other about a sign-out or
 * a change of customer, so none keeps showing access it no longer should. Only in a browser
 * or an extension, where BroadcastChannel exists; nothing happens elsewhere.
 */
function openChannel(
  name: string,
  receive: (data: unknown) => void,
): BroadcastChannel | null {
  if (
    typeof BroadcastChannel !== "function" ||
    typeof (globalThis as { location?: unknown }).location === "undefined"
  )
    return null;
  try {
    const channel = new BroadcastChannel(name);
    channel.onmessage = (event) => receive(event.data);
    // A runtime with unref (Node.js) must not stay alive for a channel.
    (channel as { unref?: () => void }).unref?.();
    return channel;
  } catch {
    return null;
  }
}

const isCode = (error: unknown, code: string) =>
  isCashSDKError(error) && error.code === code;

export class CashSDKClient {
  private readonly base: string;
  private readonly fetcher: typeof fetch;
  private readonly timeout: number;
  private readonly storage: PurchaseStorage;
  private readonly channel: BroadcastChannel | null;
  private provider: SessionTokenProvider;
  private token?: string;
  private tokenExpiry = 0;
  private epoch = 0;
  private generation = new AbortController();
  private refresh?: Promise<string>;
  private initializing?: Promise<ClientSnapshot>;
  private purchases = new Map<string, Promise<Checkout>>();
  private state = initial();
  private listeners = new Set<() => void>();
  private closed = false;
  private signedOut = false;
  private accessRequest = 0;
  private acceptedAccessRequest = 0;

  constructor(private readonly options: CashSDKOptions) {
    if (
      !/^csk_pk_[A-Za-z0-9_]+$/.test(options.publishableKey) ||
      !["sandbox", "production"].includes(options.environment) ||
      typeof options.getSessionToken !== "function"
    ) {
      throw new CashSDKError(
        "invalid_configuration",
        "A publishable key, explicit environment and session token provider are required",
      );
    }
    const storage = options.purchaseStorage;
    if (
      storage !== undefined &&
      (!storage ||
        typeof storage.get !== "function" ||
        typeof storage.set !== "function" ||
        typeof storage.remove !== "function")
    )
      throw new CashSDKError(
        "invalid_configuration",
        "purchaseStorage needs get, set and remove",
      );
    this.base = apiUrl(
      options.apiUrl ?? "https://api.cashsdk.com",
      options.environment === "sandbox",
    );
    this.timeout = options.timeoutMs ?? 15000;
    if (
      !Number.isFinite(this.timeout) ||
      this.timeout < 100 ||
      this.timeout > 60000
    )
      throw new CashSDKError(
        "invalid_configuration",
        "timeoutMs must be between 100 and 60000",
      );
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.provider = options.getSessionToken;
    this.storage = storage ?? tabStorage;
    this.channel = openChannel(
      `cashsdk:${options.publishableKey}:${options.environment}`,
      (data) => this.received(data),
    );
  }

  getSnapshot = (): ClientSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => {
    if (this.closed)
      throw new CashSDKError("destroyed", "This client was destroyed");
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  initialize(): Promise<ClientSnapshot> {
    this.assertActive();
    if (this.initializing) return this.initializing;
    if (this.state.status === "ready") return Promise.resolve(this.state);
    const epoch = this.epoch;
    this.update({ ...this.state, status: "loading", error: null });
    const operation = Promise.all([this.getCustomer(), this.getEntitlements()])
      .then(() => this.state)
      .catch((error: unknown) => {
        if (epoch === this.epoch)
          this.update({
            ...this.state,
            status: "error",
            error: toCashSDKError(error),
          });
        throw error;
      })
      .finally(() => {
        if (this.initializing === operation) this.initializing = undefined;
      });
    this.initializing = operation;
    return operation;
  }

  async getCustomer(options: RequestOptions = {}): Promise<Customer> {
    const epoch = this.epoch;
    const customer = await this.request<Customer>(
      "GET",
      "/v1/web/customer",
      options,
    );
    this.validateIdentity(customer);
    if (epoch !== this.epoch)
      throw new CashSDKError("identity_changed", "Customer session changed");
    this.update({
      ...this.state,
      customer: Object.freeze({ ...customer }),
      status: this.state.entitlements ? "ready" : this.state.status,
      error: null,
    });
    return customer;
  }

  async getEntitlements(
    options: RequestOptions = {},
  ): Promise<EntitlementSnapshot> {
    const epoch = this.epoch;
    const sequence = ++this.accessRequest;
    const snapshot = await this.request<EntitlementSnapshot>(
      "GET",
      "/v1/web/entitlements",
      options,
    );
    this.validateIdentity(snapshot);
    if (
      !Array.isArray(snapshot.entitlements) ||
      !Number.isSafeInteger(snapshot.revision) ||
      snapshot.revision < 0 ||
      !Number.isFinite(Date.parse(snapshot.computedAt)) ||
      snapshot.entitlements.some(
        (item) =>
          !item ||
          typeof item.identifier !== "string" ||
          !item.identifier ||
          typeof item.active !== "boolean" ||
          (item.expiresAt != null &&
            !Number.isFinite(Date.parse(item.expiresAt))),
      )
    )
      throw new CashSDKError(
        "invalid_response",
        "Invalid entitlement response",
      );
    if (epoch !== this.epoch)
      throw new CashSDKError("identity_changed", "Customer session changed");
    // Concurrent reads can complete in reverse order after a purchase or revocation.
    // The existing server cache revision can reset after Redis recovery. Request ordering
    // protects this client without treating a reset cache counter as permanent stale data.
    if (this.state.entitlements && sequence < this.acceptedAccessRequest)
      return this.state.entitlements;
    this.acceptedAccessRequest = sequence;
    const frozen = Object.freeze({
      ...snapshot,
      entitlements: Object.freeze(
        snapshot.entitlements.map((item) => Object.freeze({ ...item })),
      ),
    });
    this.update({
      ...this.state,
      entitlements: frozen,
      status: this.state.customer ? "ready" : this.state.status,
      error: null,
    });
    return frozen;
  }

  refreshEntitlements(options: RequestOptions = {}) {
    return this.getEntitlements(options);
  }
  getOfferings(options: RequestOptions = {}) {
    return this.request<Offerings>("GET", "/v1/web/offerings", options);
  }

  /** The customer's subscriptions from every store and provider, for an account page. */
  async getSubscriptions(options: RequestOptions = {}): Promise<Subscriptions> {
    const epoch = this.epoch;
    const result = await this.request<Subscriptions>(
      "GET",
      "/v1/web/subscriptions",
      options,
    );
    this.validateIdentity(result);
    if (
      !Array.isArray(result.subscriptions) ||
      result.subscriptions.some(
        (item) =>
          !item ||
          typeof item.productIdentifier !== "string" ||
          typeof item.active !== "boolean" ||
          typeof item.autoRenew !== "boolean" ||
          (item.expiresAt != null &&
            !Number.isFinite(Date.parse(item.expiresAt))),
      )
    )
      throw new CashSDKError(
        "invalid_response",
        "Invalid subscriptions response",
      );
    if (epoch !== this.epoch)
      throw new CashSDKError("identity_changed", "Customer session changed");
    return result;
  }

  /**
   * A checkout with your own idempotency key. Prefer `purchase`, which keeps one key per
   * customer and package for you and starts a new one when an attempt is over.
   */
  async checkout(
    input: CheckoutInput,
    options: CheckoutOptions,
  ): Promise<Checkout> {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(options?.idempotencyKey ?? ""))
      throw new CashSDKError(
        "invalid_idempotency_key",
        "Provide a stable idempotency key for this checkout attempt",
      );
    return this.validateCheckout(
      await this.request<Checkout>(
        "POST",
        "/v1/web/checkouts",
        options,
        input,
        options.idempotencyKey,
      ),
    );
  }

  async getCheckout(
    id: string,
    options: RequestOptions = {},
  ): Promise<Checkout> {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(id))
      throw new CashSDKError("invalid_checkout", "A checkout ID is required");
    return this.validateCheckout(
      await this.request<Checkout>(
        "GET",
        `/v1/web/checkouts/${encodeURIComponent(id)}`,
        options,
      ),
    );
  }

  /**
   * Buy one package: start the customer's checkout for it, or pick up the one already
   * started. Send the customer to `action.url` when the result has one.
   *
   * One idempotency key is kept per customer and package (see `purchaseStorage`), saved
   * before the request, and the checkout id is saved before this resolves. A lost answer, a
   * retry or a reload therefore reaches the same checkout, never a second one. An attempt
   * that is over makes room for the next: an expired or failed checkout (nothing was
   * charged) starts a new one at once; a complete or `needs_review` one is returned once so
   * you can show it, and the next call starts a new attempt. A refusal because the customer
   * already has the plan (`already_subscribed`, `already_owned`, `already_purchased`) also
   * ends the attempt. `checkout_in_progress` and lost connections keep it: call again.
   * Call it from a click; a second call for the same package while one runs joins it.
   */
  purchase(packageId: string, input: PurchaseInput): Promise<Checkout> {
    try {
      this.assertActive();
      validatePackage(packageId);
      if (
        !input ||
        typeof input.successUrl !== "string" ||
        !input.successUrl ||
        typeof input.cancelUrl !== "string" ||
        !input.cancelUrl
      )
        throw new CashSDKError(
          "invalid_return_url",
          "A success URL and a cancel URL are required",
        );
    } catch (error) {
      return Promise.reject(error);
    }
    const id = `${this.epoch}:${packageId}`;
    const running = this.purchases.get(id);
    if (running) return running;
    const operation = this.runPurchase(packageId, input).finally(() => {
      if (this.purchases.get(id) === operation) this.purchases.delete(id);
    });
    this.purchases.set(id, operation);
    return operation;
  }

  /**
   * The checkout of the customer's current attempt for a package, read again, or null when
   * there is none. An attempt that is over (complete, expired, failed, needs_review) is
   * cleared once read, so the next `purchase` starts a new one.
   */
  async getPurchase(
    packageId: string,
    options: RequestOptions = {},
  ): Promise<Checkout | null> {
    this.assertActive();
    validatePackage(packageId);
    const slot = await this.purchaseSlot(packageId, options.signal);
    const attempt = await readAttempt(this.storage, slot);
    if (!attempt?.id) return null;
    const checkout = await this.savedCheckout(attempt.id, options.signal);
    if (!checkout || isOver(checkout)) await clearAttempt(this.storage, slot);
    return checkout;
  }

  /**
   * On the page the customer returns to: wait for the checkout of their attempt for a
   * package, as `waitForCheckout` does. Null when there is no attempt. A checkout that is
   * over clears the attempt. Then read the entitlement: a checkout grants nothing.
   */
  async waitForPurchase(
    packageId: string,
    options: WaitOptions = {},
  ): Promise<CheckoutOutcome | null> {
    this.assertActive();
    validatePackage(packageId);
    const slot = await this.purchaseSlot(packageId, options.signal);
    const attempt = await readAttempt(this.storage, slot);
    if (!attempt?.id) return null;
    let outcome: CheckoutOutcome;
    try {
      outcome = await this.waitForCheckout(attempt.id, options);
    } catch (error) {
      if (!isCode(error, "checkout_not_found")) throw error;
      await clearAttempt(this.storage, slot);
      return null;
    }
    if (isOver(outcome.checkout)) await clearAttempt(this.storage, slot);
    return outcome;
  }

  private async runPurchase(
    packageId: string,
    input: PurchaseInput,
  ): Promise<Checkout> {
    const { signal } = input;
    const identity = this.generation.signal;
    const request: CheckoutInput = {
      packageId,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    };
    const slot = await this.purchaseSlot(packageId, signal);
    let attempt: Attempt | null = await readAttempt(this.storage, slot);
    if (attempt?.id) {
      const saved = await this.savedCheckout(attempt.id, signal);
      if (saved?.status === "requires_action") return saved;
      if (!saved || isOver(saved)) {
        await clearAttempt(this.storage, slot);
        // A purchase that went through, or whose outcome Stripe could not settle, is the
        // answer: show it. The next call starts a new attempt. An expired or failed one
        // charged nothing, so a new attempt starts now.
        if (saved && (saved.status === "complete" || saved.status === "needs_review"))
          return saved;
        attempt = null;
      }
      // A pending checkout is asked for again below, with the same key.
    }
    let renewed = false;
    for (;;) {
      const fresh = !attempt;
      if (!attempt) {
        attempt = { key: attemptKey() };
        // Saved before the request: a lost answer is retried with the same key.
        await writeAttempt(this.storage, slot, attempt);
      }
      let checkout: Checkout;
      try {
        checkout = await this.checkout(request, {
          idempotencyKey: attempt.key,
          signal,
        });
        // Still being created. The same key picks the same checkout up again.
        for (let wait = 1000; checkout.status === "pending" && wait <= 3000; wait += 1000) {
          if (attempt.id !== checkout.id) {
            attempt = { key: attempt.key, id: checkout.id };
            await writeAttempt(this.storage, slot, attempt);
          }
          await this.pause(wait, [identity, signal]);
          checkout = await this.checkout(request, {
            idempotencyKey: attempt.key,
            signal,
          });
        }
      } catch (error) {
        if (isCashSDKError(error) && FINAL_REFUSALS.has(error.code))
          await clearAttempt(this.storage, slot);
        else if (isCode(error, "idempotency_conflict") && !fresh && !renewed) {
          // The saved key belongs to another request, for example other return URLs.
          await clearAttempt(this.storage, slot);
          attempt = null;
          renewed = true;
          continue;
        }
        throw error;
      }
      if (checkout.status === "expired" || checkout.status === "failed") {
        await clearAttempt(this.storage, slot);
        // A saved key can name an attempt that ended since. Start a new one, once.
        if (!fresh && !renewed) {
          attempt = null;
          renewed = true;
          continue;
        }
        return checkout;
      }
      if (isOver(checkout)) {
        await clearAttempt(this.storage, slot);
        return checkout;
      }
      // Saved before the caller redirects, so the return page finds this checkout.
      await writeAttempt(this.storage, slot, { key: attempt.key, id: checkout.id });
      return checkout;
    }
  }

  /** The storage slot of the signed-in customer's attempt for a package. */
  private async purchaseSlot(
    packageId: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const customerId =
      this.currentCustomer() ?? (await this.getCustomer({ signal })).customerId;
    return attemptSlot(
      this.options.publishableKey,
      this.options.environment,
      customerId,
      packageId,
    );
  }

  /** A saved checkout, or null once CashSDK no longer knows it for this customer. */
  private async savedCheckout(
    id: string,
    signal: AbortSignal | undefined,
  ): Promise<Checkout | null> {
    try {
      return await this.getCheckout(id, { signal });
    } catch (error) {
      if (isCode(error, "checkout_not_found")) return null;
      throw error;
    }
  }

  /**
   * A Stripe customer portal session where the signed-in customer updates their card,
   * cancels or reads their invoices. It does not navigate: send the customer to `url`.
   * The session needs the `billing:manage` scope.
   */
  async openBillingPortal(
    input: BillingPortalInput,
    options: RequestOptions = {},
  ): Promise<BillingPortal> {
    if (
      !input ||
      typeof input.returnUrl !== "string" ||
      !input.returnUrl ||
      input.returnUrl.length > 2048
    )
      throw new CashSDKError(
        "invalid_return_url",
        "A return URL is required",
      );
    const epoch = this.epoch;
    const result = await this.request<
      BillingPortal & Customer & { provider: string }
    >("POST", "/v1/web/billing-portal", options, { returnUrl: input.returnUrl });
    this.validateIdentity(result);
    const url = stripePageUrl(result.url, "portal");
    if (!url || result.provider !== "stripe")
      throw new CashSDKError(
        "invalid_response",
        "Unsupported billing portal URL",
      );
    if (epoch !== this.epoch)
      throw new CashSDKError("identity_changed", "Customer session changed");
    return { url };
  }

  /**
   * Read a checkout until the provider reports a final state, or the time runs out.
   * Use it on the page the customer returns to. A wait that ends unsettled is not a
   * failed payment, and a settled checkout grants nothing: read the entitlements.
   */
  async waitForCheckout(
    id: string,
    options: WaitOptions = {},
  ): Promise<CheckoutOutcome> {
    const { value, done } = await this.poll(
      (signal) => this.getCheckout(id, { signal }),
      (checkout) =>
        ["expired", "failed", "needs_review"].includes(checkout.status) ||
        (checkout.status === "complete" &&
          (checkout.paymentStatus === "paid" ||
            checkout.paymentStatus === "no_payment_required")),
      options,
    );
    return { checkout: value, settled: done };
  }

  /**
   * Read access until an entitlement is active, or the time runs out. A payment and the
   * provider's verified event arrive separately, so access can follow a paid checkout by
   * a few seconds.
   */
  async waitForEntitlement(
    identifier: string,
    options: WaitOptions = {},
  ): Promise<EntitlementOutcome> {
    if (typeof identifier !== "string" || !identifier)
      throw new CashSDKError(
        "invalid_entitlement",
        "An entitlement identifier is required",
      );
    const { value, done } = await this.poll(
      (signal) => this.getEntitlements({ signal }),
      (snapshot) =>
        snapshot.entitlements.some(
          (item) =>
            item.identifier === identifier &&
            item.active &&
            (!item.expiresAt || Date.parse(item.expiresAt) > Date.now()),
        ),
      options,
    );
    return { snapshot: value, active: done };
  }

  /**
   * Bounded polling. A failure that a retry can fix (a lost connection, a timeout, a rate
   * limit, a 5xx) does not end the wait before its deadline. An abort, a sign-out or a
   * customer change ends it at once.
   */
  private async poll<T>(
    read: (signal: AbortSignal | undefined) => Promise<T>,
    finished: (value: T) => boolean,
    options: WaitOptions,
  ): Promise<{ value: T; done: boolean }> {
    this.assertActive();
    const timeout = options.timeoutMs ?? 30000;
    let interval = options.intervalMs ?? 1000;
    if (
      !Number.isFinite(timeout) ||
      timeout < 0 ||
      timeout > 300000 ||
      !Number.isFinite(interval) ||
      interval < 1000 ||
      interval > 5000
    )
      throw new CashSDKError(
        "invalid_configuration",
        "timeoutMs must be at most 300000 and intervalMs between 1000 and 5000",
      );
    const deadline = Date.now() + timeout;
    const identity = this.generation.signal;
    let last: { value: T } | undefined;
    for (;;) {
      let delay = interval;
      try {
        last = { value: await read(options.signal) };
        if (finished(last.value)) return { value: last.value, done: true };
      } catch (error) {
        // The caller stopped waiting, or the customer changed: nothing to wait for.
        if (options.signal?.aborted || identity.aborted) throw error;
        if (!(error instanceof CashSDKError) || !error.retryable) throw error;
        if (Date.now() >= deadline) {
          if (last) return { value: last.value, done: false };
          throw error;
        }
        delay = Math.max(interval, Math.min(error.retryAfterMs ?? 0, 30000));
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0 && last) return { value: last.value, done: false };
      await this.pause(Math.max(0, Math.min(delay, remaining)), [
        identity,
        options.signal,
      ]);
      interval = Math.min(interval * 1.5, 5000);
    }
  }

  private pause(
    ms: number,
    signals: (AbortSignal | undefined)[],
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const sources = signals.filter((signal): signal is AbortSignal =>
        Boolean(signal),
      );
      const stop = (signal: AbortSignal) => () => {
        cleanup();
        reject(
          signal.reason ?? new DOMException("Operation aborted", "AbortError"),
        );
      };
      const listeners = sources.map((signal) => [signal, stop(signal)] as const);
      const cleanup = () => {
        clearTimeout(timer);
        for (const [signal, listener] of listeners)
          signal.removeEventListener("abort", listener);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      for (const [signal, listener] of listeners) {
        if (signal.aborted) return listener();
        signal.addEventListener("abort", listener, { once: true });
      }
    });
  }

  private validateCheckout(checkout: Checkout): Checkout {
    if (
      !checkout ||
      typeof checkout.id !== "string" ||
      !checkout.id ||
      checkout.environment !== this.options.environment ||
      checkout.provider !== "stripe" ||
      typeof checkout.status !== "string" ||
      (checkout.customerId !== undefined &&
        checkout.customerId !== null &&
        (typeof checkout.customerId !== "string" || !checkout.customerId))
    )
      throw new CashSDKError("invalid_response", "Invalid checkout response");
    // Another tab can change the customer behind this one. A checkout for someone else is
    // never shown here.
    const owner = this.currentCustomer();
    if (checkout.customerId && owner && checkout.customerId !== owner) {
      this.identityChanged();
      throw new CashSDKError(
        "identity_changed",
        "This checkout belongs to another customer. Use setSessionTokenProvider before changing customers",
      );
    }
    let action: Checkout["action"] = null;
    if (checkout.action) {
      const url =
        checkout.action.type === "redirect"
          ? stripePageUrl(checkout.action.url, "checkout")
          : null;
      if (!url)
        throw new CashSDKError(
          "invalid_response",
          "Unsupported checkout action",
        );
      action = { type: "redirect", url };
    }
    // A status this version does not know yet is read as pending: not settled, keep the key.
    const status = STATUSES.has(checkout.status) ? checkout.status : "pending";
    return { ...checkout, status, action };
  }

  setSessionTokenProvider(provider: SessionTokenProvider): void {
    if (this.closed)
      throw new CashSDKError("destroyed", "This client was destroyed");
    if (typeof provider !== "function")
      throw new CashSDKError(
        "invalid_configuration",
        "A session token provider is required",
      );
    const token = this.token;
    this.clearIdentity();
    this.provider = provider;
    this.signedOut = false;
    this.update(initial());
    this.broadcast({ type: "customer_changed" });
    // The previous customer's session is dropped here and ended at CashSDK, so it cannot
    // outlive the account change. Nothing waits for it, and a failure changes nothing.
    if (token) void this.revoke(token).catch(() => {});
  }

  /**
   * Sign out. It resolves as soon as this client holds nothing of the customer, and other
   * tabs of the app drop their access too. Ending this tab's session at CashSDK runs on its
   * own: `revocation` says how it went and never rejects. Do not wait for it before your
   * own sign-out, whose `revokeWebSessions` ends every session of the customer anyway.
   */
  async logout(): Promise<LogoutResult> {
    const done: Promise<RevocationResult> = Promise.resolve({
      revoked: true,
      error: null,
    });
    if (this.closed || this.signedOut) return { revocation: done };
    const token = this.token;
    const customerId = this.currentCustomer();
    this.clearIdentity();
    this.signedOut = true;
    this.update({ ...initial(), status: "signed_out" });
    this.broadcast({ type: "signed_out", customerId });
    if (!token) return { revocation: done };
    return {
      revocation: this.revoke(token).then(
        (): RevocationResult => ({ revoked: true, error: null }),
        (error: unknown): RevocationResult => ({
          revoked: false,
          error: toCashSDKError(error),
        }),
      ),
    };
  }

  /** End one session at CashSDK. A 401 means it has already ended. */
  private async revoke(token: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(
          new CashSDKError("timeout", "Session revocation timed out", 0, true),
        ),
      this.timeout,
    );
    try {
      const response = await withAbort(
        this.send(`${this.base}/v1/web/sessions/current`, {
          method: "DELETE",
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          headers: this.headers(token),
          signal: controller.signal,
        }),
        controller.signal,
      );
      // Read to the end in every case, so the request completes rather than hangs open.
      const text = await withAbort(responseText(response), controller.signal);
      if (!response.ok && response.status !== 401)
        throw responseError(response, text);
    } finally {
      clearTimeout(timer);
    }
  }

  destroy(): void {
    if (this.closed) return;
    this.clearIdentity();
    this.closed = true;
    this.update({ ...initial(), status: "destroyed" });
    this.listeners.clear();
    try {
      this.channel?.close();
    } catch {
      /* Already closed. */
    }
  }

  private validateIdentity(customer: Customer) {
    if (
      !customer ||
      customer.environment !== this.options.environment ||
      typeof customer.customerId !== "string" ||
      !customer.customerId
    )
      throw new CashSDKError(
        "environment_mismatch",
        "The server response does not match this client's customer environment",
      );
    const previous = this.currentCustomer();
    if (previous && customer.customerId !== previous) {
      this.identityChanged();
      throw new CashSDKError(
        "identity_changed",
        "Use setSessionTokenProvider before changing customers",
      );
    }
  }

  /** The session now names someone else: drop everything and wait for the merchant. */
  private identityChanged() {
    this.clearIdentity();
    this.signedOut = true;
    this.update({ ...initial(), status: "signed_out" });
    this.broadcast({ type: "customer_changed" });
  }

  private currentCustomer(): string | null {
    return (
      this.state.customer?.customerId ?? this.state.entitlements?.customerId ?? null
    );
  }

  private broadcast(message: Broadcast) {
    try {
      this.channel?.postMessage(message);
    } catch {
      /* Closed, or the runtime refused the message: other tabs read again on their own. */
    }
  }

  /**
   * Another tab signed out or changed the customer. A sign-out of this tab's customer signs
   * this tab out too. A new customer sends this tab back to idle, to load whoever the backend
   * now signs in. Either way the access shown here is dropped and this tab's session ended.
   */
  private received(data: unknown) {
    if (this.closed || !data || typeof data !== "object") return;
    const message = data as { type?: unknown; customerId?: unknown };
    if (message.type === "signed_out") {
      if (this.signedOut) return;
      const current = this.currentCustomer();
      if (typeof message.customerId === "string" && current && message.customerId !== current)
        return;
      this.dropSession(true);
    } else if (message.type === "customer_changed") {
      this.dropSession(false);
    }
  }

  private dropSession(signOut: boolean) {
    const token = this.token;
    this.clearIdentity();
    this.signedOut = signOut;
    this.update(signOut ? { ...initial(), status: "signed_out" } : initial());
    if (token) void this.revoke(token).catch(() => {});
  }

  private async request<T>(
    method: "GET" | "DELETE" | "POST",
    path: string,
    options: RequestOptions,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    this.assertActive();
    const epoch = this.epoch;
    const controller = new AbortController();
    const sources = [this.generation.signal, options.signal].filter(
      (signal): signal is AbortSignal => Boolean(signal),
    );
    const removers = sources.map((signal) => {
      const abort = () => controller.abort(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      return () => signal.removeEventListener("abort", abort);
    });
    const timer = setTimeout(
      () =>
        controller.abort(
          new CashSDKError("timeout", "CashSDK request timed out", 0, true),
        ),
      this.timeout,
    );
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        aborted(controller.signal);
        const token = await withAbort(this.sessionToken(), controller.signal);
        const response = await withAbort(
          this.send(`${this.base}${path}`, {
            method,
            headers: {
              ...this.headers(token),
              ...(body ? { "Content-Type": "application/json" } : {}),
              ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            credentials: "omit",
            cache: "no-store",
            redirect: "error",
            signal: controller.signal,
          }),
          controller.signal,
        );
        if (response.status === 401 && attempt === 0) {
          // A key CashSDK refuses is a configuration error: a new session cannot fix it, so
          // the backend is not asked for one.
          const refusal = responseError(
            response,
            await withAbort(responseText(response), controller.signal),
          );
          if (refusal.code === "invalid_publishable_key") throw refusal;
          // Another concurrent request may already have replaced this rejected token.
          if (this.token === token) {
            this.token = undefined;
            this.tokenExpiry = 0;
          }
          continue;
        }
        const result = await withAbort(
          responseJSON<T>(response),
          controller.signal,
        );
        if (epoch !== this.epoch)
          throw new CashSDKError(
            "identity_changed",
            "Customer session changed",
          );
        return result;
      }
      throw new CashSDKError(
        "invalid_web_session",
        "Could not establish a customer session",
        401,
      );
    } finally {
      clearTimeout(timer);
      removers.forEach((remove) => remove());
    }
  }

  /** One fetch. A failure with no response becomes a retryable `network_error`. */
  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetcher(url, init);
    } catch (error) {
      throw networkError(error, init.signal ?? undefined);
    }
  }

  private sessionToken(): Promise<string> {
    if (this.token && this.tokenExpiry > Date.now() + 15000)
      return Promise.resolve(this.token);
    if (this.refresh) return this.refresh;
    const epoch = this.epoch;
    const controller = new AbortController();
    const source = this.generation.signal;
    const cancel = () => controller.abort(source.reason);
    source.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(
      () =>
        controller.abort(
          new CashSDKError("timeout", "Customer authentication timed out"),
        ),
      this.timeout,
    );
    const refresh = withAbort(
      Promise.resolve()
        .then(() => {
          aborted(controller.signal);
          return this.provider({ signal: controller.signal });
        })
        .catch((error: unknown) => {
          // The merchant's provider failed, usually because nobody is signed in there.
          throw controller.signal.aborted || isCashSDKError(error)
            ? error
            : new CashSDKError(
                "session_unavailable",
                error instanceof Error && error.message
                  ? error.message
                  : "Your backend did not return a customer session",
                0,
                false,
                undefined,
                undefined,
                { cause: error },
              );
        }),
      controller.signal,
    )
      .then((result) => {
        const receivedAt = Date.now();
        if (
          typeof result !== "string" &&
          (!result || typeof result.token !== "string")
        )
          throw new CashSDKError(
            "invalid_web_session",
            "The merchant backend returned an invalid session",
          );
        const token = typeof result === "string" ? result : result.token;
        const expiry =
          typeof result === "string"
            ? receivedAt + SHORT_SESSION_MS
            : sessionExpiry(result, receivedAt);
        if (epoch !== this.epoch)
          throw new CashSDKError(
            "identity_changed",
            "Customer session changed",
          );
        if (!/^csk_ws_[A-Za-z0-9_-]{43}$/.test(token) || expiry === null)
          throw new CashSDKError(
            "invalid_web_session",
            "The merchant backend returned an invalid or expired session",
          );
        this.token = token;
        this.tokenExpiry = expiry;
        return token;
      })
      .finally(() => {
        clearTimeout(timer);
        source.removeEventListener("abort", cancel);
        if (this.refresh === refresh) this.refresh = undefined;
      });
    this.refresh = refresh;
    return refresh;
  }

  private headers(token: string) {
    return {
      Authorization: `Bearer ${this.options.publishableKey}`,
      "X-CashSDK-Web-Session": token,
      Accept: "application/json",
    };
  }
  private assertActive() {
    if (this.closed || this.signedOut)
      throw new CashSDKError(
        this.closed ? "destroyed" : "signed_out",
        "Configure a new authenticated session before using this client",
      );
  }
  private clearIdentity() {
    this.epoch++;
    this.generation.abort(
      new CashSDKError("identity_changed", "Customer session changed"),
    );
    this.generation = new AbortController();
    this.token = undefined;
    this.tokenExpiry = 0;
    this.refresh = undefined;
    this.initializing = undefined;
    this.purchases.clear();
  }
  private update(snapshot: ClientSnapshot) {
    this.state = Object.freeze(snapshot);
    // A consumer listener cannot interrupt credential cleanup or another listener.
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* Consumer-owned listener. */
      }
    }
  }
}

function validatePackage(packageId: unknown): asserts packageId is string {
  if (typeof packageId !== "string" || !packageId || packageId.length > 200)
    throw new CashSDKError("invalid_package", "A package ID is required");
}

export function createCashSDK(options: CashSDKOptions): CashSDKClient {
  return new CashSDKClient(options);
}
