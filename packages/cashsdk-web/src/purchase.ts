import { CashSDKError } from "./http.js";
import type { Checkout, PurchaseStorage } from "./types.js";

/** One purchase attempt: its idempotency key and, once known, its checkout. */
export interface Attempt {
  key: string;
  id?: string;
}

/**
 * Refusals that end an attempt. The customer already has the plan or the product, or a
 * payment for it already went through; access follows. A new attempt needs a new key.
 */
export const FINAL_REFUSALS: ReadonlySet<string> = new Set([
  "already_subscribed",
  "already_owned",
  "already_purchased",
]);

/** A checkout that no longer takes a payment: the next purchase is a new attempt. */
export const isOver = (checkout: Checkout) =>
  checkout.status === "complete" ||
  checkout.status === "expired" ||
  checkout.status === "failed" ||
  checkout.status === "needs_review";

const memory = new Map<string, string>();

/**
 * The tab's sessionStorage, so an attempt survives the redirect to Stripe and back. When
 * storage is blocked (a sandboxed frame, a privacy setting, a full quota) the attempt is
 * kept in memory instead, which lasts until the page unloads. Read only when called.
 */
export const tabStorage: PurchaseStorage = {
  get(key) {
    if (memory.has(key)) return memory.get(key);
    try {
      return globalThis.sessionStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      const storage = globalThis.sessionStorage;
      if (storage) {
        storage.setItem(key, value);
        memory.delete(key);
        return;
      }
    } catch {
      /* Blocked or full: keep it for this page. */
    }
    memory.set(key, value);
  },
  remove(key) {
    memory.delete(key);
    try {
      globalThis.sessionStorage?.removeItem(key);
    } catch {
      /* Blocked: nothing was stored there. */
    }
  },
};

/** Where one customer's attempt for one package is kept. */
export function attemptSlot(
  publishableKey: string,
  environment: string,
  customerId: string,
  packageId: string,
): string {
  return `cashsdk.purchase:${JSON.stringify([publishableKey, environment, customerId, packageId])}`;
}

const storageError = (error: unknown) =>
  new CashSDKError(
    "storage_unavailable",
    "The purchase attempt could not be saved or read. Nothing was sent.",
    0,
    false,
    undefined,
    undefined,
    { cause: error },
  );

export async function readAttempt(
  storage: PurchaseStorage,
  slot: string,
): Promise<Attempt | null> {
  let stored: string | null | undefined;
  try {
    stored = await storage.get(slot);
  } catch (error) {
    throw storageError(error);
  }
  if (typeof stored !== "string" || !stored) return null;
  try {
    const value = JSON.parse(stored) as Partial<Attempt> | null;
    if (
      value &&
      typeof value.key === "string" &&
      /^[A-Za-z0-9_-]{16,128}$/.test(value.key) &&
      (value.id === undefined ||
        (typeof value.id === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value.id)))
    )
      return value.id ? { key: value.key, id: value.id } : { key: value.key };
  } catch {
    /* Not one of ours. */
  }
  await clearAttempt(storage, slot);
  return null;
}

/** Saved before the request that uses it, and again before the caller redirects. */
export async function writeAttempt(
  storage: PurchaseStorage,
  slot: string,
  attempt: Attempt,
): Promise<void> {
  try {
    await storage.set(
      slot,
      JSON.stringify(attempt.id ? { key: attempt.key, id: attempt.id } : { key: attempt.key }),
    );
  } catch (error) {
    throw storageError(error);
  }
}

/** A stale attempt is harmless: the next read finds its checkout over and replaces it. */
export async function clearAttempt(
  storage: PurchaseStorage,
  slot: string,
): Promise<void> {
  try {
    await storage.remove(slot);
  } catch {
    /* See above. */
  }
}

/** 32 random hexadecimal characters. Works without a secure context, unlike randomUUID. */
export function attemptKey(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
