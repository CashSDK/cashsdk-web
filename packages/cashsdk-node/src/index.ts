import { CashSDKError, type Environment } from "cashsdk-web";
import { createHmac, timingSafeEqual } from "node:crypto";
export { CashSDKError } from "cashsdk-web";

export interface CashSDKServerOptions {
  secretKey: string;
  environment: Environment;
  apiUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}
export interface CreateSessionInput {
  customerId: string;
  origin: string;
  scopes?: (
    | "customer:read"
    | "entitlements:read"
    | "subscriptions:read"
    | "offerings:read"
    | "checkout:create"
    | "checkout:read"
    | "billing:manage"
  )[];
  ttlSeconds?: number;
}
export interface WebSession {
  token: string;
  expiresAt: string;
  customerId: string;
  environment: Environment;
  scopes: string[];
}

export interface BillingPortalInput {
  /** From your verified authentication, as for `createWebSession`. */
  customerId: string;
  /** Where Stripe sends the customer back. HTTPS, or loopback HTTP in sandbox. */
  returnUrl: string;
  /** A Stripe customer portal configuration (`bpc_...`). Defaults to the account's default. */
  configuration?: string;
}
export interface BillingPortalSession {
  customerId: string;
  environment: Environment;
  provider: "stripe";
  /** Stripe's customer portal. It expires within minutes: redirect the customer at once. */
  url: string;
}

/**
 * A request that failed before a response arrived (offline, DNS, a refused or reset
 * connection) as a retryable `network_error`, as in `cashsdk-web`. The fetch error stays as
 * `cause`. An abort, a timeout or an error the SDK already made passes through unchanged.
 */
function networkError(error: unknown, signal: AbortSignal): unknown {
  if (
    signal.aborted ||
    error instanceof CashSDKError ||
    (error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError"))
  )
    return error;
  return new CashSDKError(
    "network_error",
    "CashSDK could not be reached. Check the connection and try again.",
    0,
    true,
    undefined,
    undefined,
    { cause: error },
  );
}

export class CashSDKServer {
  private readonly origin: string;
  private readonly fetcher: typeof fetch;
  private readonly timeout: number;
  constructor(private readonly options: CashSDKServerOptions) {
    if (
      !/^csk_(?:sk|rk)_[A-Za-z0-9_]+$/.test(options.secretKey) ||
      !["sandbox", "production"].includes(options.environment)
    )
      throw new CashSDKError(
        "invalid_configuration",
        "A server key and explicit environment are required",
      );
    if (
      ((options.secretKey.startsWith("csk_sk_live_") ||
        options.secretKey.startsWith("csk_rk_live_")) &&
        options.environment !== "production") ||
      ((options.secretKey.startsWith("csk_sk_test_") ||
        options.secretKey.startsWith("csk_rk_test_")) &&
        options.environment !== "sandbox")
    )
      throw new CashSDKError(
        "environment_mismatch",
        "The key mode and configured environment differ",
      );
    const url = new URL(options.apiUrl ?? "https://api.cashsdk.com");
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(
          options.environment === "sandbox" &&
          local &&
          url.protocol === "http:"
        ))
    )
      throw new CashSDKError(
        "invalid_configuration",
        "Use an HTTPS API origin, or sandbox loopback HTTP",
      );
    this.origin = url.origin;
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeout = options.timeoutMs ?? 15000;
    if (
      !Number.isFinite(this.timeout) ||
      this.timeout < 100 ||
      this.timeout > 60000
    )
      throw new CashSDKError("invalid_configuration", "Invalid timeoutMs");
  }

  /** The caller must derive customerId from its authenticated backend session. */
  createWebSession(
    input: CreateSessionInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<WebSession> {
    return this.request(
      "POST",
      "/v1/web/sessions",
      { ...input, environment: this.options.environment },
      options.signal,
    );
  }

  /**
   * End every browser session of one customer. Call it from your sign-out handler: each
   * tab holds its own session, and the browser's own logout only revokes that tab's.
   */
  revokeWebSessions(
    customerId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ revoked: number }> {
    if (!customerId || customerId.length > 200)
      throw new CashSDKError("invalid_customer", "A customer ID is required");
    return this.request(
      "POST",
      "/v1/web/sessions:revoke",
      { customerId, environment: this.options.environment },
      options.signal,
    );
  }

  /**
   * A Stripe customer portal session for one customer, where they update their card,
   * cancel or read their invoices. Only that customer's own Stripe customer is ever used.
   */
  async createBillingPortalSession(
    input: BillingPortalInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<BillingPortalSession> {
    if (
      !input ||
      typeof input.customerId !== "string" ||
      !input.customerId ||
      input.customerId.length > 200
    )
      throw new CashSDKError("invalid_customer", "A customer ID is required");
    if (
      typeof input.returnUrl !== "string" ||
      !input.returnUrl ||
      input.returnUrl.length > 2048
    )
      throw new CashSDKError("invalid_return_url", "A return URL is required");
    const session = await this.request<BillingPortalSession>(
      "POST",
      `/v1/web/customers/${encodeURIComponent(input.customerId)}/billing-portal`,
      {
        environment: this.options.environment,
        returnUrl: input.returnUrl,
        ...(input.configuration ? { configuration: input.configuration } : {}),
      },
      options.signal,
    );
    let url: URL | null = null;
    try {
      url = typeof session?.url === "string" ? new URL(session.url) : null;
    } catch {
      url = null;
    }
    if (
      !url ||
      session.customerId !== input.customerId ||
      session.environment !== this.options.environment ||
      url.protocol !== "https:" ||
      url.hostname !== "billing.stripe.com" ||
      url.port ||
      url.username ||
      url.password
    )
      throw new CashSDKError(
        "invalid_response",
        "CashSDK returned an unsupported billing portal session",
      );
    return session;
  }

  getEntitlements(
    customerId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ServerEntitlements> {
    if (!customerId || customerId.length > 200)
      throw new CashSDKError("invalid_customer", "A customer ID is required");
    const environment =
      this.options.environment === "sandbox" ? "Sandbox" : "Production";
    return this.request(
      "GET",
      `/v1/customers/${encodeURIComponent(customerId)}/entitlements?environment=${environment}`,
      undefined,
      options.signal,
    );
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(
      () =>
        controller.abort(
          new CashSDKError(
            "timeout",
            "CashSDK server request timed out",
            0,
            true,
          ),
        ),
      this.timeout,
    );
    const bounded = async <V>(operation: Promise<V>): Promise<V> => {
      if (controller.signal.aborted) void operation.catch(() => {});
      controller.signal.throwIfAborted();
      let cancel: () => void = () => {};
      const canceled = new Promise<never>((_resolve, reject) => {
        cancel = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", cancel, { once: true });
      });
      try {
        return await Promise.race([operation, canceled]);
      } finally {
        controller.signal.removeEventListener("abort", cancel);
      }
    };
    try {
      controller.signal.throwIfAborted();
      const send = async (url: string, init: RequestInit) => {
        try {
          return await this.fetcher(url, init);
        } catch (error) {
          throw networkError(error, controller.signal);
        }
      };
      const response = await bounded(
        send(`${this.origin}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.options.secretKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
          redirect: "error",
          cache: "no-store",
          credentials: "omit",
        }),
      );
      const text = await bounded(
        // The connection can also break while the body is arriving.
        response.text().catch((error: unknown) => {
          throw networkError(error, controller.signal);
        }),
      );
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw new CashSDKError(
          "invalid_response",
          "CashSDK returned an invalid response",
          response.status,
        );
      }
      if (!response.ok) {
        const envelope =
          data && typeof data === "object"
            ? (data as Record<string, unknown>)
            : {};
        const error =
          envelope.error && typeof envelope.error === "object"
            ? (envelope.error as Record<string, unknown>)
            : envelope;
        throw new CashSDKError(
          typeof error.code === "string"
            ? error.code
            : `http_${response.status}`,
          typeof error.message === "string"
            ? error.message
            : "CashSDK request failed",
          response.status,
          typeof error.retryable === "boolean"
            ? error.retryable
            : response.status === 429 || response.status >= 500,
          response.headers.get("x-request-id") ??
            (typeof error.requestId === "string" ? error.requestId : undefined),
        );
      }
      return data as T;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
}

export interface ServerEntitlements {
  entitlements: {
    identifier: string;
    name: string;
    source: string;
    expiresAt?: string | null;
  }[];
  tier: number;
  tier_identifier: string | null;
  app_user_id: string;
  customer_exists: boolean;
  environment: string;
}

export interface WebhookEvent {
  id: string;
  type: string;
  [key: string]: unknown;
}
export interface VerifyWebhookOptions {
  secrets: readonly string[];
  toleranceSeconds?: number;
  now?: Date;
  maxBytes?: number;
}

/** Verify exact received bytes before parsing. Receivers still deduplicate event.id. */
export function verifyWebhook(
  rawBody: string | Uint8Array,
  signature: string,
  options: VerifyWebhookOptions,
): WebhookEvent {
  const body =
    typeof rawBody === "string"
      ? Buffer.from(rawBody, "utf8")
      : Buffer.from(rawBody);
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const tolerance = options.toleranceSeconds ?? 300;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    body.length > maxBytes ||
    !Number.isFinite(tolerance) ||
    tolerance < 1 ||
    tolerance > 3600 ||
    !options.secrets.length ||
    options.secrets.some((secret) => !secret)
  )
    throw new CashSDKError(
      "invalid_webhook_configuration",
      "Invalid webhook verification parameters",
    );
  if (typeof signature !== "string" || signature.length > 8192)
    throw new CashSDKError("invalid_signature", "Invalid webhook signature");
  const parts = signature.split(",").map((part) => part.trim().split("="));
  const times = parts.filter(([key]) => key === "t").map(([, value]) => value);
  const signatures = parts
    .filter(([key]) => key === "v1")
    .map(([, value]) => value)
    .filter(
      (value): value is string =>
        typeof value === "string" && /^[a-f0-9]{64}$/i.test(value),
    );
  const timestamp = times[0];
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (
    times.length !== 1 ||
    !timestamp ||
    !/^\d{1,12}$/.test(timestamp) ||
    !Number.isFinite(now) ||
    Math.abs(now - Number(timestamp)) > tolerance ||
    !signatures.length
  )
    throw new CashSDKError(
      "invalid_signature",
      "Invalid or expired webhook signature",
    );
  const valid = options.secrets.some((secret) => {
    const expected = createHmac("sha256", secret)
      .update(`${timestamp}.`)
      .update(body)
      .digest();
    return signatures.some((value) =>
      timingSafeEqual(expected, Buffer.from(value, "hex")),
    );
  });
  if (!valid)
    throw new CashSDKError(
      "invalid_signature",
      "Webhook signature does not match",
    );
  let event: unknown;
  try {
    event = JSON.parse(body.toString("utf8"));
  } catch {
    throw new CashSDKError("invalid_webhook", "Webhook body is not JSON");
  }
  if (
    !event ||
    typeof event !== "object" ||
    typeof (event as WebhookEvent).id !== "string" ||
    typeof (event as WebhookEvent).type !== "string"
  )
    throw new CashSDKError(
      "invalid_webhook",
      "Webhook event ID and type are required",
    );
  return event as WebhookEvent;
}
