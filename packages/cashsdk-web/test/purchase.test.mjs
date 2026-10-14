import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { CashSDKClient } from "../dist/index.js";

const token = (letter = "a") => `csk_ws_${letter.repeat(43)}`;
const json = (data, status = 200) => Response.json(data, { status });
const input = {
  successUrl: "https://merchant.example/return",
  cancelUrl: "https://merchant.example/pricing",
};
const KEY = /^[A-Za-z0-9_-]{16,128}$/;

/** The checkout routes of the API, one checkout per customer and idempotency key. */
function fakeApi() {
  const api = {
    customerId: "customer_1",
    owner: null,
    initialStatus: "requires_action",
    checkouts: new Map(),
    keys: new Map(),
    posts: [],
    gets: [],
    refuse: null,
    offline: false,
    seen: null,
    set(id, status, paymentStatus = status === "complete" ? "paid" : null) {
      const current = api.checkouts.get(id);
      api.checkouts.set(id, {
        ...current,
        status,
        paymentStatus,
        action:
          status === "requires_action"
            ? { type: "redirect", url: `https://checkout.stripe.com/c/pay/${id}` }
            : null,
      });
    },
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      if (path === "/v1/web/customer")
        return json({ customerId: api.customerId, environment: "sandbox" });
      if (path === "/v1/web/sessions/current") return json({ revoked: true });
      if (path === "/v1/web/checkouts" && init.method === "POST") {
        const key = init.headers["Idempotency-Key"];
        api.posts.push({ key, body: JSON.parse(init.body), seen: api.seen?.() });
        if (api.offline) throw new TypeError("Failed to fetch");
        const refusal = api.refuse?.(key);
        if (refusal) return refusal;
        const scoped = `${api.customerId}:${key}`;
        let id = api.keys.get(scoped);
        if (!id) {
          id = `wco_${api.keys.size + 1}`;
          api.keys.set(scoped, id);
          api.checkouts.set(id, {
            id,
            provider: "stripe",
            environment: "sandbox",
            customerId: api.owner ?? api.customerId,
            mode: "subscription",
            productIdentifier: "price_monthly",
            accessStatus: "check_entitlements",
            expiresAt: null,
          });
          api.set(id, api.initialStatus);
        }
        return json(api.checkouts.get(id), 201);
      }
      const read = /^\/v1\/web\/checkouts\/([^/]+)$/.exec(path);
      if (read) {
        api.gets.push(read[1]);
        const found = api.checkouts.get(read[1]);
        return found
          ? json(found)
          : json({ error: { code: "checkout_not_found", message: "Checkout not found" } }, 404);
      }
      throw new Error(`unexpected ${init.method} ${path}`);
    },
  };
  return api;
}
const refusal = (code, status = 409, retryable = false) =>
  json({ error: { code, message: code, retryable } }, status);

let stored;
beforeEach(() => {
  stored = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => (stored.has(key) ? stored.get(key) : null),
    setItem: (key, value) => void stored.set(key, String(value)),
    removeItem: (key) => void stored.delete(key),
  };
});
afterEach(() => {
  delete globalThis.sessionStorage;
});

const sdkFor = (api, options = {}) =>
  new CashSDKClient({
    publishableKey: "csk_pk_example",
    environment: "sandbox",
    getSessionToken: async () => token(),
    fetch: api.fetch,
    ...options,
  });
const attempts = () => [...stored.values()].map((value) => JSON.parse(value));

test("a purchase saves its key before the request and its checkout before it resolves", async () => {
  const api = fakeApi();
  api.seen = () => attempts();
  const sdk = sdkFor(api);
  const checkout = await sdk.purchase("pkg_monthly", input);
  assert.equal(checkout.status, "requires_action");
  assert.equal(checkout.action.url, "https://checkout.stripe.com/c/pay/wco_1");
  assert.equal(api.posts.length, 1);
  const [post] = api.posts;
  assert.match(post.key, KEY);
  assert.deepEqual(post.seen, [{ key: post.key }], "the key was saved before it was sent");
  assert.deepEqual(post.body, { packageId: "pkg_monthly", ...input });
  assert.deepEqual(attempts(), [{ key: post.key, id: "wco_1" }], "and the checkout before the redirect");
  const [slot] = stored.keys();
  assert(slot.startsWith("cashsdk.purchase:") && slot.includes("customer_1") && slot.includes("pkg_monthly"));
  // Back from Stripe without paying: the same checkout, without a second one.
  const again = await sdk.purchase("pkg_monthly", input);
  assert.equal(again.id, "wco_1");
  assert.equal(api.posts.length, 1);
  assert.deepEqual(api.gets, ["wco_1"]);
  sdk.destroy();
});

test("an attempt that is over makes room for the next purchase, with a new key", async () => {
  const api = fakeApi();
  const sdk = sdkFor(api);
  const first = await sdk.purchase("pkg_monthly", input);
  // Paid: the next click shows the finished purchase once and forgets it.
  api.set(first.id, "complete");
  const done = await sdk.purchase("pkg_monthly", input);
  assert.equal(done.status, "complete");
  assert.equal(api.posts.length, 1, "a finished purchase never starts another by itself");
  assert.equal(stored.size, 0);
  // The second purchase of the same plan gets its own key and checkout.
  const second = await sdk.purchase("pkg_monthly", input);
  assert.equal(second.id, "wco_2");
  assert.notEqual(api.posts[1].key, api.posts[0].key);
  // Expired or failed: nothing was charged, so the same click starts a new attempt.
  for (const [status, previous, next] of [
    ["expired", "wco_2", "wco_3"],
    ["failed", "wco_3", "wco_4"],
  ]) {
    api.set(previous, status);
    const renewed = await sdk.purchase("pkg_monthly", input);
    assert.equal(renewed.id, next, status);
    assert.equal(renewed.status, "requires_action");
    assert.deepEqual(attempts(), [{ key: api.posts.at(-1).key, id: next }]);
  }
  // Under review: shown once, then a new attempt only when asked again.
  api.set("wco_4", "needs_review");
  assert.equal((await sdk.purchase("pkg_monthly", input)).status, "needs_review");
  assert.equal(stored.size, 0);
  assert.equal((await sdk.purchase("pkg_monthly", input)).id, "wco_5");
  sdk.destroy();
});

test("a pending checkout is asked for again with the same key", async () => {
  const api = fakeApi();
  api.initialStatus = "pending";
  const original = api.fetch;
  api.fetch = async (url, init) => {
    const response = await original(url, init);
    // Stripe's page is ready by the second request.
    if (init.method === "POST" && api.posts.length === 1) api.set("wco_1", "requires_action");
    return response;
  };
  const sdk = sdkFor(api);
  api.fetch = original;
  const checkout = await sdk.purchase("pkg_monthly", input);
  assert.equal(checkout.status, "requires_action");
  assert.equal(api.posts.length, 2);
  assert.equal(api.posts[0].key, api.posts[1].key);
  assert.deepEqual(attempts(), [{ key: api.posts[0].key, id: "wco_1" }]);
  // Still pending when the retries run out: kept, and the next call goes on with the key.
  const stuck = await sdk.purchase("pkg_yearly", input);
  assert.equal(stuck.status, "pending");
  assert.equal(new Set(api.posts.slice(2).map((post) => post.key)).size, 1);
  api.set(stuck.id, "requires_action");
  assert.equal((await sdk.purchase("pkg_yearly", input)).id, stuck.id);
  sdk.destroy();
});

test("a refusal because the customer already has it ends the attempt; a busy plan or a lost connection keeps it", async () => {
  const api = fakeApi();
  const sdk = sdkFor(api);
  for (const code of ["already_subscribed", "already_owned", "already_purchased"]) {
    api.refuse = () => refusal(code);
    await assert.rejects(sdk.purchase("pkg_monthly", input), { code, retryable: false });
    assert.equal(stored.size, 0, `${code} clears the attempt`);
  }
  const keys = new Set(api.posts.map((post) => post.key));
  assert.equal(keys.size, 3, "each refused attempt had its own key");
  api.refuse = () => refusal("checkout_in_progress", 503, true);
  await assert.rejects(sdk.purchase("pkg_monthly", input), { code: "checkout_in_progress", retryable: true });
  const kept = attempts()[0].key;
  api.refuse = null;
  api.offline = true;
  await assert.rejects(sdk.purchase("pkg_monthly", input), { code: "network_error" });
  api.offline = false;
  const checkout = await sdk.purchase("pkg_monthly", input);
  assert.deepEqual(
    api.posts.slice(-3).map((post) => post.key),
    [kept, kept, kept],
    "a retry after an uncertain failure is the same purchase",
  );
  assert.equal(checkout.status, "requires_action");
  sdk.destroy();
});

test("each package and each customer has its own attempt, so one refused plan blocks nothing else", async () => {
  const api = fakeApi();
  const sdk = sdkFor(api);
  api.refuse = () => (api.posts.length === 1 ? refusal("catalog_price_mismatch") : null);
  await assert.rejects(sdk.purchase("pkg_monthly", input), { code: "catalog_price_mismatch" });
  const yearly = await sdk.purchase("pkg_yearly", input);
  assert.equal(yearly.status, "requires_action");
  assert.notEqual(api.posts[1].key, api.posts[0].key);
  const monthly = await sdk.purchase("pkg_monthly", input);
  assert.equal(api.posts[2].key, api.posts[0].key, "the refused plan retries its own key");
  assert.notEqual(monthly.id, yearly.id);
  // Another customer signs in on this device: their attempts start from scratch.
  api.customerId = "customer_2";
  sdk.setSessionTokenProvider(async () => token("b"));
  const theirs = await sdk.purchase("pkg_monthly", input);
  assert.notEqual(api.posts.at(-1).key, api.posts[0].key);
  assert.notEqual(theirs.id, monthly.id);
  assert.equal(stored.size, 3);
  sdk.destroy();
});

test("a saved key that belongs to another request is replaced once", async () => {
  const api = fakeApi();
  const sdk = sdkFor(api);
  await sdk.getCustomer();
  const slot = `cashsdk.purchase:${JSON.stringify(["csk_pk_example", "sandbox", "customer_1", "pkg_monthly"])}`;
  const old = "old_attempt_key_0001";
  stored.set(slot, JSON.stringify({ key: old }));
  api.refuse = (key) => (key === old ? refusal("idempotency_conflict") : null);
  const checkout = await sdk.purchase("pkg_monthly", input);
  assert.equal(checkout.status, "requires_action");
  assert.equal(api.posts[0].key, old);
  assert.notEqual(api.posts[1].key, old);
  // Not one of ours: dropped, and a new attempt starts.
  stored.set(slot, "{not json");
  api.refuse = null;
  assert.equal((await sdk.purchase("pkg_monthly", input)).status, "requires_action");
  sdk.destroy();
});

test("a double click is one purchase", async () => {
  const api = fakeApi();
  const sdk = sdkFor(api);
  const first = sdk.purchase("pkg_monthly", input);
  const second = sdk.purchase("pkg_monthly", input);
  assert.equal(first, second);
  await first;
  assert.equal(api.posts.length, 1);
  const [a, b] = await Promise.all([sdk.purchase("pkg_a", input), sdk.purchase("pkg_b", input)]);
  assert.notEqual(a.id, b.id, "two packages are two purchases");
  sdk.destroy();
});

test("blocked storage keeps the attempt in memory for the page", async () => {
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    get() {
      throw new DOMException("The operation is insecure.", "SecurityError");
    },
  });
  const api = fakeApi();
  const sdk = sdkFor(api);
  // Package ids of their own: what is kept in memory lasts for this whole test file.
  const first = await sdk.purchase("pkg_blocked", input);
  assert.equal((await sdk.purchase("pkg_blocked", input)).id, first.id);
  assert.equal(api.posts.length, 1);
  // A full quota is the same.
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    writable: true,
    value: {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      },
      removeItem: () => {},
    },
  });
  const full = await sdk.purchase("pkg_full", input);
  assert.equal((await sdk.purchase("pkg_full", input)).id, full.id);
  assert.equal(api.posts.length, 2);
  sdk.destroy();
});

test("a custom storage may be asynchronous, and one that fails stops the purchase before it is sent", async () => {
  const area = new Map();
  const purchaseStorage = {
    get: async (key) => area.get(key) ?? null,
    set: async (key, value) => void area.set(key, value),
    remove: async (key) => void area.delete(key),
  };
  const api = fakeApi();
  const worker = sdkFor(api, { purchaseStorage });
  const first = await worker.purchase("pkg_monthly", input);
  worker.destroy();
  assert.equal(stored.size, 0, "the tab storage is not used");
  // The service worker stopped and started again.
  const restarted = sdkFor(api, { purchaseStorage });
  assert.equal((await restarted.purchase("pkg_monthly", input)).id, first.id);
  assert.equal(api.posts.length, 1);
  restarted.destroy();
  const broken = sdkFor(api, {
    purchaseStorage: {
      get: async () => null,
      set: async () => {
        throw new Error("storage is full");
      },
      remove: async () => {},
    },
  });
  await assert.rejects(broken.purchase("pkg_yearly", input), (error) => {
    assert.equal(error.code, "storage_unavailable");
    assert.equal(error.cause.message, "storage is full");
    return true;
  });
  assert.equal(api.posts.length, 1, "nothing was sent without a saved key");
  broken.destroy();
  assert.throws(() => sdkFor(api, { purchaseStorage: { get() {} } }), { code: "invalid_configuration" });
});

test("getPurchase and waitForPurchase read the attempt, and clear it once it is over", async () => {
  const api = fakeApi();
  const sdk = sdkFor(api);
  assert.equal(await sdk.getPurchase("pkg_monthly"), null);
  assert.equal(await sdk.waitForPurchase("pkg_monthly"), null);
  assert.equal(api.gets.length, 0, "no attempt, no read");
  const started = await sdk.purchase("pkg_monthly", input);
  assert.equal((await sdk.getPurchase("pkg_monthly")).status, "requires_action");
  assert.equal(stored.size, 1);
  setTimeout(() => api.set(started.id, "complete"), 300);
  const outcome = await sdk.waitForPurchase("pkg_monthly", { intervalMs: 1000, timeoutMs: 5000 });
  assert.equal(outcome.settled, true);
  assert.equal(outcome.checkout.status, "complete");
  assert.equal(stored.size, 0, "a finished purchase is forgotten");
  assert.equal(await sdk.getPurchase("pkg_monthly"), null);
  // CashSDK no longer knows the saved checkout for this customer.
  await sdk.purchase("pkg_yearly", input);
  api.checkouts.clear();
  assert.equal(await sdk.getPurchase("pkg_yearly"), null);
  assert.equal(stored.size, 0);
  sdk.destroy();
});

test("a purchase checks its input before it sends anything", async () => {
  const api = fakeApi();
  const sdk = sdkFor(api);
  for (const packageId of ["", "x".repeat(201), 7, null])
    await assert.rejects(sdk.purchase(packageId, input), { code: "invalid_package" });
  for (const bad of [null, {}, { successUrl: "https://merchant.example/return" }, { ...input, cancelUrl: "" }])
    await assert.rejects(sdk.purchase("pkg_monthly", bad), { code: "invalid_return_url" });
  await assert.rejects(sdk.getPurchase(""), { code: "invalid_package" });
  assert.equal(api.posts.length + api.gets.length, 0);
  await sdk.logout();
  await assert.rejects(sdk.purchase("pkg_monthly", input), { code: "signed_out" });
  sdk.destroy();
});

test("a checkout that comes back for another customer is never returned by a purchase", async () => {
  const api = fakeApi();
  api.owner = "customer_2";
  const sdk = sdkFor(api);
  await assert.rejects(sdk.purchase("pkg_monthly", input), { code: "identity_changed" });
  assert.equal(sdk.getSnapshot().status, "signed_out");
  sdk.destroy();
});
