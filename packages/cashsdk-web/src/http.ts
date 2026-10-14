/**
 * Every failure the SDK reports. Decide on `code`, never on `message`. `status` is 0 when
 * no response arrived: `network_error` (CashSDK could not be reached), `timeout`, and the
 * client's own `identity_changed`, `signed_out` and `destroyed`.
 */
export class CashSDKError extends Error {
  readonly name = "CashSDKError";
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0,
    readonly retryable = false,
    readonly requestId?: string,
    readonly retryAfterMs?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const isAbort = (error: unknown) =>
  error instanceof Error &&
  (error.name === "AbortError" || error.name === "TimeoutError");

/** A CashSDKError, also one made by another copy of this package. */
export function isCashSDKError(error: unknown): error is CashSDKError {
  return (
    error instanceof CashSDKError ||
    (error instanceof Error &&
      error.name === "CashSDKError" &&
      typeof (error as { code?: unknown }).code === "string")
  );
}

/**
 * Any failure as a CashSDKError. One the SDK did not make (a custom fetch's own abort, a
 * caller's abort reason) is `unknown_error`, with the original as `cause`.
 */
export function toCashSDKError(error: unknown): CashSDKError {
  if (isCashSDKError(error)) return error;
  return new CashSDKError(
    "unknown_error",
    error instanceof Error && error.message
      ? error.message
      : "The CashSDK request failed",
    0,
    false,
    undefined,
    undefined,
    { cause: error },
  );
}

/**
 * A request that failed before a response arrived (offline, DNS, a refused or reset
 * connection) as a retryable `network_error`. The fetch error stays as `cause`. An abort, a
 * timeout or an error the SDK already made passes through unchanged.
 */
export function networkError(error: unknown, signal?: AbortSignal): unknown {
  if (signal?.aborted || error instanceof CashSDKError || isAbort(error))
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

export function apiUrl(value: string, sandbox: boolean): string {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(sandbox && local && url.protocol === "http:"))
  ) {
    throw new CashSDKError(
      "invalid_configuration",
      "Use an HTTPS API origin, or sandbox loopback HTTP",
    );
  }
  return url.origin;
}

const STRIPE_PAGES = {
  checkout: { host: "checkout.stripe.com", path: "/c/pay/" },
  portal: { host: "billing.stripe.com", path: "/p/session/" },
} as const;

/**
 * A page Stripe hosts: Checkout, or the customer portal. Stripe serves it from its own host
 * or, for an account with a custom domain, from that domain under the same path (`/c/pay/`
 * for Checkout, `/p/session/` for the portal). It must be HTTPS on the default port, with no
 * user name or password, on a real domain name (not an IP address, not localhost). Returns
 * the normalized URL, or null.
 */
export function stripePageUrl(
  value: unknown,
  page: keyof typeof STRIPE_PAGES,
): string | null {
  let url: URL;
  try {
    if (typeof value !== "string") return null;
    url = new URL(value);
  } catch {
    return null;
  }
  const { host, path } = STRIPE_PAGES[page];
  const domain =
    /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
      url.hostname,
    );
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    !domain ||
    (url.hostname !== host && !url.pathname.startsWith(path))
  )
    return null;
  return url.href;
}

export function aborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw signal.reason ?? new DOMException("Operation aborted", "AbortError");
}

/** Bound even custom fetch/token implementations that do not observe AbortSignal. */
export function withAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => {});
    return Promise.reject(
      signal.reason ?? new DOMException("Operation aborted", "AbortError"),
    );
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", cancel);
    const cancel = () => {
      cleanup();
      reject(
        signal.reason ?? new DOMException("Operation aborted", "AbortError"),
      );
    };
    signal.addEventListener("abort", cancel, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/** `Retry-After` in milliseconds: delay seconds or an HTTP date. */
export function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const delay = /^\d+$/.test(value.trim())
    ? Number(value.trim()) * 1000
    : Date.parse(value) - Date.now();
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}

/** The body as text. The connection can still break while it arrives. */
export async function responseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    throw networkError(error);
  }
}

/**
 * A refused request as a CashSDKError. The HTTP status decides whether a retry can help
 * (429 and 5xx), so a proxy's HTML error page is as retryable as CashSDK's own JSON. A JSON
 * body then adds the code, the message, the request id and the server's own retry advice.
 */
export function responseError(response: Response, text: string): CashSDKError {
  let value: unknown = null;
  try {
    value = JSON.parse(text);
  } catch {
    /* Not JSON, for example a proxy's error page. The status says enough. */
  }
  const envelope =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const error =
    envelope.error && typeof envelope.error === "object"
      ? (envelope.error as Record<string, unknown>)
      : envelope;
  return new CashSDKError(
    typeof error.code === "string" ? error.code : `http_${response.status}`,
    typeof error.message === "string"
      ? error.message
      : "The CashSDK request failed",
    response.status,
    // The server says when a retry can help. Older responses leave it to the status.
    typeof error.retryable === "boolean"
      ? error.retryable
      : response.status === 429 || response.status >= 500,
    response.headers.get("x-request-id") ??
      (typeof error.requestId === "string" ? error.requestId : undefined),
    retryAfterMs(response.headers.get("retry-after")),
  );
}

export async function responseJSON<T>(response: Response): Promise<T> {
  const text = await responseText(response);
  if (!response.ok) throw responseError(response, text);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new CashSDKError(
      "invalid_response",
      "CashSDK returned an invalid response",
      response.status,
    );
  }
}
