import {
  aborted,
  apiUrl,
  CashSDKError,
  responseJSON,
  withAbort,
} from "./http.js";
import type {
  CashSDKOptions,
  Checkout,
  CheckoutInput,
  CheckoutOptions,
  CheckoutOutcome,
  ClientSnapshot,
  Customer,
  EntitlementOutcome,
  EntitlementSnapshot,
  Offerings,
  RequestOptions,
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

export class CashSDKClient {
  private readonly base: string;
  private readonly fetcher: typeof fetch;
  private readonly timeout: number;
  private provider: SessionTokenProvider;
  private token?: string;
  private tokenExpiry = 0;
  private epoch = 0;
  private generation = new AbortController();
  private refresh?: Promise<string>;
  private initializing?: Promise<ClientSnapshot>;
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
            error:
              error instanceof Error
                ? error
                : new Error("Initialization failed"),
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
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id))
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

  /** Bounded polling. A failure that a retry can fix does not end the wait. */
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
      interval < 100 ||
      interval > 5000
    )
      throw new CashSDKError(
        "invalid_configuration",
        "timeoutMs must be at most 300000 and intervalMs between 100 and 5000",
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
      checkout.environment !== this.options.environment ||
      checkout.provider !== "stripe" ||
      ![
        "pending",
        "requires_action",
        "complete",
        "expired",
        "failed",
        "needs_review",
      ].includes(checkout.status)
    )
      throw new CashSDKError("invalid_response", "Invalid checkout response");
    if (checkout.action) {
      let url: URL;
      try {
        url = new URL(checkout.action.url);
      } catch {
        throw new CashSDKError("invalid_response", "Invalid checkout action");
      }
      if (
        checkout.action.type !== "redirect" ||
        url.protocol !== "https:" ||
        url.hostname !== "checkout.stripe.com" ||
        url.port ||
        url.username ||
        url.password
      )
        throw new CashSDKError(
          "invalid_response",
          "Unsupported checkout action",
        );
    }
    return checkout;
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
    // The previous customer's session is dropped here and ended at CashSDK, so it cannot
    // outlive the account change. Nothing waits for it, and a failure changes nothing.
    if (token) void this.revoke(token).catch(() => {});
  }

  async logout(): Promise<void> {
    if (this.closed || this.signedOut) return;
    const token = this.token;
    this.clearIdentity();
    this.signedOut = true;
    this.update({ ...initial(), status: "signed_out" });
    if (token) await this.revoke(token);
  }

  /** End one session at CashSDK. A 401 means it has already ended. */
  private async revoke(token: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(
          new CashSDKError("timeout", "Session revocation timed out"),
        ),
      this.timeout,
    );
    try {
      const response = await withAbort(
        this.fetcher(`${this.base}/v1/web/sessions/current`, {
          method: "DELETE",
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          headers: this.headers(token),
          signal: controller.signal,
        }),
        controller.signal,
      );
      if (response.status !== 401)
        await withAbort(responseJSON(response), controller.signal);
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
    const previous =
      this.state.customer?.customerId ?? this.state.entitlements?.customerId;
    if (previous && customer.customerId !== previous) {
      this.clearIdentity();
      this.signedOut = true;
      this.update({ ...initial(), status: "signed_out" });
      throw new CashSDKError(
        "identity_changed",
        "Use setSessionTokenProvider before changing customers",
      );
    }
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
          this.fetcher(`${this.base}${path}`, {
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
          // Another concurrent request may already have replaced this rejected token.
          if (this.token === token) {
            this.token = undefined;
            this.tokenExpiry = 0;
          }
          if (response.body)
            await withAbort(response.body.cancel(), controller.signal);
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
      Promise.resolve().then(() => {
        aborted(controller.signal);
        return this.provider({ signal: controller.signal });
      }),
      controller.signal,
    )
      .then((result) => {
        if (
          typeof result !== "string" &&
          (!result || typeof result.token !== "string")
        )
          throw new CashSDKError(
            "invalid_web_session",
            "The merchant backend returned an invalid session",
          );
        const token = typeof result === "string" ? result : result.token;
        const expiresAt =
          typeof result === "string" || !result.expiresAt
            ? Date.now() + 60000
            : Date.parse(result.expiresAt);
        if (epoch !== this.epoch)
          throw new CashSDKError(
            "identity_changed",
            "Customer session changed",
          );
        if (
          !/^csk_ws_[A-Za-z0-9_-]{43}$/.test(token) ||
          !Number.isFinite(expiresAt) ||
          expiresAt <= Date.now()
        )
          throw new CashSDKError(
            "invalid_web_session",
            "The merchant backend returned an invalid or expired session",
          );
        this.token = token;
        this.tokenExpiry = expiresAt;
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

export function createCashSDK(options: CashSDKOptions): CashSDKClient {
  return new CashSDKClient(options);
}
