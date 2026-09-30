export class CashSDKError extends Error {
  readonly name = "CashSDKError";
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0,
    readonly retryable = false,
    readonly requestId?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
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

export async function responseJSON<T>(response: Response): Promise<T> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new CashSDKError(
      "invalid_response",
      "CashSDK returned an invalid response",
      response.status,
      response.status >= 500,
    );
  }
  if (!response.ok) {
    const envelope =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
    const error =
      envelope.error && typeof envelope.error === "object"
        ? (envelope.error as Record<string, unknown>)
        : envelope;
    const retry = response.headers.get("retry-after");
    const seconds =
      retry && /^\d+$/.test(retry)
        ? Number(retry) * 1000
        : retry
          ? Date.parse(retry) - Date.now()
          : undefined;
    throw new CashSDKError(
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
      seconds !== undefined && Number.isFinite(seconds)
        ? Math.max(0, seconds)
        : undefined,
    );
  }
  return value as T;
}
