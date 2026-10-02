"use client";

import type {
  BillingPortal,
  BillingPortalInput,
  CashSDKClient,
  Checkout,
  CheckoutInput,
  CheckoutOptions,
  ClientSnapshot,
  EntitlementSnapshot,
  Offerings,
  RequestOptions,
  Subscriptions,
  WebSubscription,
} from "cashsdk-web";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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

/** Create the client once in the application. Its owner controls logout and destruction. */
export function CashSDKProvider({
  client,
  children,
}: {
  client: CashSDKClient;
  children: ReactNode;
}) {
  useEffect(() => {
    void client.initialize().catch(() => {
      /* Error is exposed in the client snapshot. */
    });
  }, [client]);
  return <Context.Provider value={client}>{children}</Context.Provider>;
}

export function useCashSDK(): CashSDKClient {
  const client = useContext(Context);
  if (!client) throw new Error("CashSDK hooks require CashSDKProvider");
  return client;
}

export function useCashSDKState(): ClientSnapshot {
  const client = useCashSDK();
  return useSyncExternalStore(
    client.subscribe,
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
  error: Error | null;
  /** Read again, for example after a purchase or a catalog change. */
  refresh: () => void;
}

interface Loaded<T> {
  customerId: string | null;
  data: T | null;
  status: Read<T>["status"];
  error: Error | null;
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
            error: error instanceof Error ? error : new Error(failure),
          });
      },
    );
    // Strict Mode mounts effects twice. The first read is cancelled, not duplicated in state.
    return () => controller.abort();
  }, [client, customerId, request, failure]);
  const current: Loaded<T> =
    customerId && loaded.customerId === customerId ? loaded : notLoaded;
  return {
    data: current.data,
    status: customerId && current === notLoaded ? "loading" : current.status,
    error: current.error,
    refresh: useCallback(() => setRequest((value) => value + 1), []),
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

export interface CheckoutResult {
  checkout: Checkout | null;
  status: "idle" | "starting" | "started" | "error";
  error: Error | null;
  /**
   * Start a checkout. Call it from a click or submit handler, never from an effect or
   * during render. Keep one idempotency key per purchase attempt and store it before the
   * call, so a lost response is retried as the same purchase.
   */
  start: (input: CheckoutInput, options: CheckoutOptions) => Promise<Checkout>;
  reset: () => void;
}

/** One checkout at a time: a second call while one is starting joins the first. */
export function useCheckout(): CheckoutResult {
  const client = useCashSDK();
  const running = useRef<Promise<Checkout> | null>(null);
  const [state, setState] = useState<{
    checkout: Checkout | null;
    status: CheckoutResult["status"];
    error: Error | null;
  }>({ checkout: null, status: "idle", error: null });
  const start = useCallback(
    (input: CheckoutInput, options: CheckoutOptions) => {
      if (running.current) return running.current;
      setState({ checkout: null, status: "starting", error: null });
      const operation = client
        .checkout(input, options)
        .then(
          (checkout) => {
            setState({ checkout, status: "started", error: null });
            return checkout;
          },
          (error: unknown) => {
            setState({
              checkout: null,
              status: "error",
              error:
                error instanceof Error
                  ? error
                  : new Error("Could not start checkout"),
            });
            throw error;
          },
        )
        .finally(() => {
          if (running.current === operation) running.current = null;
        });
      running.current = operation;
      return operation;
    },
    [client],
  );
  const reset = useCallback(
    () => setState({ checkout: null, status: "idle", error: null }),
    [],
  );
  return { ...state, start, reset };
}

export interface BillingPortalResult {
  portal: BillingPortal | null;
  status: "idle" | "starting" | "started" | "error";
  error: Error | null;
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

interface PortalState {
  /** The customer the portal was opened for. A portal is never shown to the next one. */
  owner: string | null;
  portal: BillingPortal | null;
  status: BillingPortalResult["status"];
  error: Error | null;
}
const idlePortal: PortalState = {
  owner: null,
  portal: null,
  status: "idle",
  error: null,
};

/**
 * One portal session at a time: a second call while one is starting joins the first.
 * When the customer changes, the previous customer's portal and error are dropped.
 */
export function useBillingPortal(): BillingPortalResult {
  const client = useCashSDK();
  const customerId = useCashSDKState().customer?.customerId ?? null;
  const running = useRef<Promise<BillingPortal> | null>(null);
  const [state, setState] = useState<PortalState>(idlePortal);
  const start = useCallback(
    (input: BillingPortalInput, options?: RequestOptions) => {
      if (running.current) return running.current;
      const owner = client.getSnapshot().customer?.customerId ?? null;
      setState({ owner, portal: null, status: "starting", error: null });
      const operation = client
        .openBillingPortal(input, options)
        .then(
          (portal) => {
            setState({ owner, portal, status: "started", error: null });
            return portal;
          },
          (error: unknown) => {
            setState({
              owner,
              portal: null,
              status: "error",
              error:
                error instanceof Error
                  ? error
                  : new Error("Could not open the billing portal"),
            });
            throw error;
          },
        )
        .finally(() => {
          if (running.current === operation) running.current = null;
        });
      running.current = operation;
      return operation;
    },
    [client],
  );
  const reset = useCallback(() => setState(idlePortal), []);
  const current = state.owner === customerId ? state : idlePortal;
  return {
    portal: current.portal,
    status: current.status,
    error: current.error,
    start,
    reset,
  };
}
