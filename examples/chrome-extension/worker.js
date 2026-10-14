import { createExtensionCashSDK, openCheckoutTab, openBillingPortalTab } from './sdk/extension.js';
let client;
let activeConfig;
let queue = Promise.resolve();
const origin = `chrome-extension://${chrome.runtime.id}`;

function safeURL(value, environment) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(environment === 'sandbox' && local && url.protocol === 'http:'))) throw new Error('Use HTTPS URLs, or loopback HTTP in sandbox.');
  return url;
}

async function getClient() {
  if (client) return client;
  const { configuration } = await chrome.storage.local.get('configuration');
  if (!configuration) throw new Error('Save your configuration and sign in first.');
  const c = configuration;
  safeURL(c.backendSessionURL, c.environment);
  safeURL(c.returnURL, c.environment);
  safeURL(c.apiUrl, c.environment);
  activeConfig = c;
  client = createExtensionCashSDK({
    runtime: chrome.runtime, publishableKey: c.publishableKey, environment: c.environment, apiUrl: c.apiUrl,
    getSessionToken: async ({ signal }) => {
      const { backendToken } = await chrome.storage.session.get('backendToken');
      if (!backendToken) throw new Error('Sign in with your merchant backend session token.');
      const response = await fetch(c.backendSessionURL, {
        method: 'POST', headers: { Authorization: `Bearer ${backendToken}`, 'X-CashSDK-Client-Origin': origin },
        credentials: 'omit', cache: 'no-store', redirect: 'error', signal,
      });
      if (!response.ok) throw new Error('Your backend refused the session. Sign in again.');
      return response.json();
    },
  });
  return client;
}

async function handle(message) {
  if (message.type === 'configure') {
    const c = message.configuration;
    if (!c || !['sandbox', 'production'].includes(c.environment) || !/^csk_pk_[A-Za-z0-9_]+$/.test(c.publishableKey)) throw new Error('Enter a publishable key and environment.');
    safeURL(c.backendSessionURL, c.environment); safeURL(c.returnURL, c.environment); safeURL(c.apiUrl, c.environment);
    if (!message.backendToken || /^(?:csk_(?:sk|rk)_|(?:sk|rk)_(?:test|live)_)/.test(message.backendToken)) throw new Error('Use your signed-in merchant session token, never a CashSDK or Stripe server key.');
    if (client) { try { await client.logout(); } finally { client.destroy(); client = undefined; } }
    await chrome.storage.local.set({ configuration: c });
    await chrome.storage.session.set({ backendToken: message.backendToken });
  }
  if (message.type === 'logout') {
    try { if (client) await client.logout(); }
    finally {
      client?.destroy(); client = undefined;
      await chrome.storage.session.remove('backendToken');
    }
    return { signedOut: true };
  }
  const sdk = await getClient();
  await sdk.initialize();
  const customer = sdk.getSnapshot().customer;
  const pendingKey = `checkout:${JSON.stringify([activeConfig.apiUrl, activeConfig.publishableKey, activeConfig.environment, customer.customerId])}`;
  if (message.type === 'buy') {
    const offering = await sdk.getOfferings();
    const selected = offering.current?.packages.find((pkg) => pkg.id === message.packageId);
    if (!selected?.purchasable) throw new Error('This package is not available for checkout.');
    const subscriptions = await sdk.getSubscriptions();
    if (subscriptions.subscriptions.some((sub) => sub.active && sub.productIdentifier === selected.product.identifier)) throw new Error('This subscription is already active. Use Manage billing.');
    const saved = (await chrome.storage.local.get(pendingKey))[pendingKey];
    let attempt = saved;
    if (attempt?.checkoutId) {
      const checkout = await sdk.getCheckout(attempt.checkoutId);
      if (['complete', 'pending', 'needs_review'].includes(checkout.status)) {
        return { checkout, entitlements: await sdk.getEntitlements() };
      }
      if (checkout.status === 'requires_action') {
        await openCheckoutTab(chrome.tabs, checkout);
        return { checkout };
      }
      attempt = undefined;
    }
    if (attempt && attempt.packageId !== message.packageId) throw new Error('Resolve your pending checkout before choosing another plan.');
    attempt ??= { key: crypto.randomUUID(), packageId: message.packageId };
    // Persist before the request. Worker suspension or a lost response must reuse this key.
    await chrome.storage.local.set({ [pendingKey]: attempt });
    const checkout = await sdk.checkout({ packageId: attempt.packageId, successUrl: activeConfig.returnURL, cancelUrl: activeConfig.returnURL }, { idempotencyKey: attempt.key });
    await chrome.storage.local.set({ [pendingKey]: { ...attempt, checkoutId: checkout.id } });
    if (checkout.status === 'requires_action') await openCheckoutTab(chrome.tabs, checkout);
    return { checkout };
  }
  if (message.type === 'portal') {
    await openBillingPortalTab(chrome.tabs, await sdk.openBillingPortal({ returnUrl: activeConfig.returnURL }));
    return { opened: true };
  }
  if (!['configure', 'refresh'].includes(message.type)) throw new Error('Unsupported action.');
  const [entitlements, offerings, subscriptions] = await Promise.all([sdk.getEntitlements(), sdk.getOfferings(), sdk.getSubscriptions()]);
  const attempt = (await chrome.storage.local.get(pendingKey))[pendingKey];
  const checkout = attempt?.checkoutId ? await sdk.getCheckout(attempt.checkoutId) : null;
  if (checkout && ['complete', 'expired', 'failed'].includes(checkout.status) && (checkout.status !== 'complete' || entitlements.entitlements.some((e) => e.active))) {
    await chrome.storage.local.remove(pendingKey);
  }
  return { customer, entitlements, offerings, subscriptions, checkout };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Content scripts and other extensions cannot choose customers, tokens, URLs or actions.
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return false;
  const operation = queue.then(() => handle(message));
  queue = operation.catch(() => {});
  operation.then((result) => respond({ result }), (error) => respond({ error: { code: error.code, message: error.message } }));
  return true;
});
