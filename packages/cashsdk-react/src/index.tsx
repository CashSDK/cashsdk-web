"use client";

import {
  CashSDKError,
  type BillingPortal,
  type BillingPortalInput,
  type CashSDKClient,
  type Checkout,
  type CheckoutInput,
  type CheckoutOptions,
  type ClientSnapshot,
  type EntitlementSnapshot,
  type Offerings,
  type PurchaseInput,
  type RequestOptions,
  type Subscriptions,
  type WebSubscription,
} from "cashsdk-web";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
const Context = createContext<CashSDKClient | null>(null);
const serverSnapshot: ClientSnapshot = Object.freeze({
  status: "idle",
  customer: null,
  entitlements: null,
  error: null,
});

/**
 * Every hook error as a CashSDKError, so `error.code` is always there. One the SDK did not
 * make is `unknown_error`, with the original as `cause`.
 */
function asCashSDKError(error: unknown, failure: string): CashSDKError {
  if (
    error instanceof Error &&
    error.name === "CashSDKError" &&
    typeof (error as { code?: unknown }).code === "string"
  )
    return error as CashSDKError;
  return new CashSDKError(
    "unknown_error",
    error instanceof Error && error.message ? error.message : failure,
    0,
    false,
    undefined,
    undefined,
    { cause: error },
  );
}

/**
 * Subscribe to a client that may already be destroyed. A destroyed client has nothing left to
 * report, so its subscription is a no-op instead of an error thrown during render.
 */
function subscriber(client: CashSDKClient) {
  return (listener: () => void) => {
    try {
      return client.subscribe(listener);
    } catch {
      return () => {};
    }
  };
}

/** Create the client once in the application. Its owner controls logout and destruction. */
export function CashSDKProvider({
  client,
  children,
}: {
  client: CashSDKClient;
  children: ReactNode;
}) {
  const subscribe = useMemo(() => subscriber(client), [client]);
  const status = useSyncExternalStore(
    subscribe,
    () => client.getSnapshot().status,
    () => serverSnapshot.status,
  );
  useEffect(() => {
    // Load the customer whenever the client is idle: on mount, and again after
    // setSessionTokenProvider() for a new account. A signed-out or destroyed client waits for
    // its owner. initialize() can throw synchronously, so it runs inside the promise chain.
    if (status !== "idle") return;
    void Promise.resolve()
      .then(() => client.initialize())
      .catch(() => {
        /* Error is exposed in the client snapshot. */
      });
  }, [client, status]);
  return <Context.Provider value={client}>{children}</Context.Provider>;
}

export function useCashSDK(): CashSDKClient {
  const client = useContext(Context);
  if (!client) throw new Error("CashSDK hooks require CashSDKProvider");
  return client;
}

export function useCashSDKState(): ClientSnapshot {
  const client = useCashSDK();
  const subscribe = useMemo(() => subscriber(client), [client]);
  return useSyncExternalStore(
    subscribe,
    client.getSnapshot,
    () => serverSnapshot,
  );
}

export function useCustomer() {
  const state = useCashSDKState();
  return { customer: state.customer, status: state.status, error: state.error };
}

export function useEntitlements() {
  const client = useCashSDK();
  const state = useCashSDKState();
  return {
    snapshot: state.entitlements,
    status: state.status,
    error: state.error,
    // After a failed first load (a lost connection, say) there is no customer yet, so a
    // retry loads the customer and access again rather than leaving the state in error.
    refresh: async (): Promise<EntitlementSnapshot> =>
      client.getSnapshot().customer
        ? client.refreshEntitlements()
        : (await client.initialize()).entitlements!,
    isActive: (identifier: string) =>
      Boolean(
        state.entitlements?.entitlements.some(
          (item) =>
            item.identifier === identifier &&
            item.active &&
            (!item.expiresAt || Date.parse(item.expiresAt) > Date.now()),
        ),
      ),
  };
}

interface Read<T> {
  data: T | null;
  status: "idle" | "loading" | "ready" | "error";
  error: CashSDKError | null;
  /** Read again, for example after a purchase or a catalog change. */
  refresh: () => void;
}

interface Loaded<T> {
  customerId: string | null;
  data: T | null;
  status: Read<T>["status"];
  error: CashSDKError | null;
}
const notLoaded: Loaded<never> = {
  customerId: null,
  data: null,
  status: "idle",
  error: null,
};

/**
 * One read that belongs to the signed-in customer. It runs once the client is ready and
 * again when the customer changes. A result read for one customer is never returned for
 * the next.
 */
function useCustomerRead<T>(
  read: (client: CashSDKClient, signal: AbortSignal) => Promise<T>,
  failure: string,
): Read<T> {
  const client = useCashSDK();
  const state = useCashSDKState();
  const customerId =
    state.status === "ready" ? (state.customer?.customerId ?? null) : null;
  const [loaded, setLoaded] = useState<Loaded<T>>(notLoaded);
  const [request, setRequest] = useState(0);
  // The latest reader, without making a new function identity start a new read.
  const reader = useRef(read);
  reader.current = read;
  useEffect(() => {
    if (!customerId) return;
    const controller = new AbortController();
    setLoaded((previous) => ({
      customerId,
      data: previous.customerId === customerId ? previous.data : null,
      status: "loading",
      error: null,
    }));
    reader.current(client, controller.signal).then(
      (data) => {
        if (!controller.signal.aborted)
          setLoaded({ customerId, data, status: "ready", error: null });
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setLoaded({
            customerId,
            data: null,
            status: "error",
            error: asCashSDKError(error, failure),
          });
      },
    );
    // Strict Mode mounts effects twice. The first read is cancelled, not duplicated in state.
    return () => controller.abort();
  }, [client, customerId, request, failure]);
  const current: Loaded<T> =
    customerId && loaded.customerId === customerId ? loaded : notLoaded;
  const refresh = useCallback(() => setRequest((value) => value + 1), []);
  // Nothing can be read while the client itself failed to load the customer: report its error
  // rather than an idle read that never starts.
  if (!customerId && state.status === "error")
    return { data: null, status: "error", error: state.error, refresh };
  return {
    data: current.data,
    status: customerId && current === notLoaded ? "loading" : current.status,
    error: current.error,
    refresh,
  };
}

export interface OfferingsResult extends Omit<Read<Offerings>, "data"> {
  offerings: Offerings | null;
}

/** The current offering for the signed-in customer. */
export function useOfferings(): OfferingsResult {
  const { data, ...rest } = useCustomerRead(
    (client, signal) => client.getOfferings({ signal }),
    "Could not load offerings",
  );
  return { offerings: data, ...rest };
}

export interface SubscriptionsResult
  extends Omit<Read<Subscriptions>, "data"> {
  subscriptions: readonly WebSubscription[];
}

/** The signed-in customer's subscriptions, for an account page. */
export function useSubscriptions(): SubscriptionsResult {
  const { data, ...rest } = useCustomerRead(
    (client, signal) => client.getSubscriptions({ signal }),
    "Could not load subscriptions",
  );
  return { subscriptions: data?.subscriptions ?? [], ...rest };
}

type ActionStatus = "idle" | "starting" | "started" | "error";
interface Action<T> {
  /** The customer the result belongs to. It is never shown to the next one. */
  owner: string | null;
  value: T | null;
  status: ActionStatus;
  error: CashSDKError | null;
}
const idle: Action<never> = { owner: null, value: null, status: "idle", error: null };

/**
 * One action at a time, started from a handler. A second call that `joins` the running one
 * gets its promise; any other is refused. When the customer changes, the previous customer's
 * result and error are dropped.
 */
function useAction<A extends unknown[], T>(
  perform: (client: CashSDKClient, ...args: A) => Promise<T>,
  failure: string,
  joins: (running: A, next: A) => boolean,
  ownerOf: (value: T) => string | null | undefined = () => undefined,
) {
  const client = useCashSDK();
  const customerId = useCashSDKState().customer?.customerId ?? null;
  const running = useRef<{ args: A; operation: Promise<T> } | null>(null);
  // The latest arguments, without making new function identities change `start`.
  const config = useRef({ perform, failure, joins, ownerOf });
  config.current = { perform, failure, joins, ownerOf };
  const [state, setState] = useState<Action<T>>(idle);
  const start = useCallback(
    (...args: A): Promise<T> => {
      const { perform, failure, joins, ownerOf } = config.current;
      const current = running.current;
      if (current) {
        if (joins(current.args, args)) return current.operation;
        return Promise.reject(
          new CashSDKError(
            "purchase_in_progress",
            "Another purchase is starting. Try again once it has finished.",
            0,
            true,
          ),
        );
      }
      const owner = client.getSnapshot().customer?.customerId ?? null;
      // Whoever the client knows once the call is over: the customer may have loaded meanwhile.
      const settledOwner = () =>
        client.getSnapshot().customer?.customerId ?? owner;
      setState({ owner, value: null, status: "starting", error: null });
      const operation = Promise.resolve()
        .then(() => perform(client, ...args))
        .then(
          (value) => {
            setState({
              owner: ownerOf(value) ?? settledOwner(),
              value,
              status: "started",
              error: null,
            });
            return value;
          },
          (error: unknown) => {
            setState({
              owner: settledOwner(),
              value: null,
              status: "error",
              error: asCashSDKError(error, failure),
            });
            throw error;
          },
        )
        .finally(() => {
          if (running.current?.operation === operation) running.current = null;
        });
      running.current = { args, operation };
      return operation;
    },
    [client],
  );
  const reset = useCallback(() => setState(idle), []);
  const current =
    state.owner === customerId || state.status === "starting" ? state : idle;
  return { current, start, reset };
}

export interface CheckoutResult {
  checkout: Checkout | null;
  status: ActionStatus;
  error: CashSDKError | null;
  /**
   * Start a checkout with your own idempotency key. Prefer `usePurchase`, which keeps the
   * key for you. Call it from a click or submit handler, never from an effect or during
   * render. Keep one key per purchase attempt and store it before the call, so a lost
   * response is retried as the same purchase.
   */
  start: (input: CheckoutInput, options: CheckoutOptions) => Promise<Checkout>;
  reset: () => void;
}

/**
 * One checkout at a time: a second call while one is starting joins the first. When the
 * customer changes, the previous customer's checkout and error are dropped.
 */
export function useCheckout(): CheckoutResult {
  const { current, start, reset } = useAction(
    (client, input: CheckoutInput, options: CheckoutOptions) =>
      client.checkout(input, options),
    "Could not start checkout",
    () => true,
    (checkout) => checkout.customerId,
  );
  return {
    checkout: current.value,
    status: current.status,
    error: current.error,
    start,
    reset,
  };
}

export interface PurchaseResult {
  /** The latest purchase's checkout. Send the customer to `checkout.action.url`. */
  checkout: Checkout | null;
  status: ActionStatus;
  error: CashSDKError | null;
  /**
   * Buy a package, as `client.purchase` does: one idempotency key per customer and package,
   * kept for you, and a new one once an attempt is over. Call it from a click handler, never
   * from an effect or during render. A second click for the same package joins the running
   * purchase; one for another package is refused with `purchase_in_progress`.
   */
  start: (packageId: string, input: PurchaseInput) => Promise<Checkout>;
  reset: () => void;
}

/** Sell a package. When the customer changes, the previous customer's purchase is dropped. */
export function usePurchase(): PurchaseResult {
  const { current, start, reset } = useAction(
    (client, packageId: string, input: PurchaseInput) =>
      client.purchase(packageId, input),
    "Could not start the purchase",
    (running, next) => running[0] === next[0],
    (checkout) => checkout.customerId,
  );
  return {
    checkout: current.value,
    status: current.status,
    error: current.error,
    start,
    reset,
  };
}

export interface BillingPortalResult {
  portal: BillingPortal | null;
  status: ActionStatus;
  error: CashSDKError | null;
  /**
   * Open a Stripe customer portal session. Call it from a click handler, never from an
   * effect or during render, then send the customer to `portal.url` at once: the session
   * expires within minutes. It needs a session with the `billing:manage` scope.
   */
  start: (
    input: BillingPortalInput,
    options?: RequestOptions,
  ) => Promise<BillingPortal>;
  reset: () => void;
}

/**
 * One portal session at a time: a second call while one is starting joins the first.
 * When the customer changes, the previous customer's portal and error are dropped.
 */
export function useBillingPortal(): BillingPortalResult {
  const { current, start, reset } = useAction(
    (client, input: BillingPortalInput, options?: RequestOptions) =>
      client.openBillingPortal(input, options),
    "Could not open the billing portal",
    () => true,
  );
  return {
    portal: current.value,
    status: current.status,
    error: current.error,
    start,
    reset,
  };
}
