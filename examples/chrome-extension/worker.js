import { createExtensionCashSDK, openCheckoutTab, openBillingPortalTab } from './sdk/extension.js';
let client;
let activeConfig;
let queue = Promise.resolve();
const origin = `chrome-extension://${chrome.runtime.id}`;
// Purchase attempts (one idempotency key and checkout id per customer and package) outlive
// the service worker, which Chrome stops whenever it likes.
const purchaseStorage = {
  get: async (key) => (await chrome.storage.local.get(key))[key] ?? null,
  set: (key, value) => chrome.storage.local.set({ [key]: value }),
  remove: (key) => chrome.storage.local.remove(key),
};

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
    purchaseStorage,
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

/** Sign out without waiting for CashSDK: local access is gone once logout resolves. */
async function signOut() {
  if (!client) return;
  const current = client;
  client = undefined;
  try { await current.logout(); } finally { current.destroy(); }
}

async function handle(message) {
  if (message.type === 'configure') {
    const c = message.configuration;
    if (!c || !['sandbox', 'production'].includes(c.environment) || !/^csk_pk_[A-Za-z0-9_]+$/.test(c.publishableKey)) throw new Error('Enter a publishable key and environment.');
    safeURL(c.backendSessionURL, c.environment); safeURL(c.returnURL, c.environment); safeURL(c.apiUrl, c.environment);
    if (!message.backendToken || /^(?:csk_(?:sk|rk)_|(?:sk|rk)_(?:test|live)_)/.test(message.backendToken)) throw new Error('Use your signed-in merchant session token, never a CashSDK or Stripe server key.');
    await signOut();
    await chrome.storage.local.set({ configuration: c });
    await chrome.storage.session.set({ backendToken: message.backendToken });
  }
  if (message.type === 'logout') {
    try { await signOut(); }
    finally { await chrome.storage.session.remove('backendToken'); }
    return { signedOut: true };
  }
  const sdk = await getClient();
  await sdk.initialize();
  const customer = sdk.getSnapshot().customer;
  if (message.type === 'buy') {
    const offering = await sdk.getOfferings();
    const selected = offering.current?.packages.find((pkg) => pkg.id === message.packageId);
    // The server marks a package not purchasable once the customer has its access.
    if (!selected?.purchasable) throw new Error('This package is not available for checkout.');
    // An older server does not refuse a second subscription by itself.
    const { subscriptions } = await sdk.getSubscriptions();
    if (subscriptions.some((sub) => sub.active && sub.productIdentifier === selected.product.identifier)) throw new Error('This subscription is already active. Use Manage billing.');
    // Resumes the open checkout for this package, or starts one. Each package has its own
    // attempt, and one that is over (paid, expired, refused) makes room for the next.
    const checkout = await sdk.purchase(selected.id, { successUrl: activeConfig.returnURL, cancelUrl: activeConfig.returnURL });
    if (checkout.status === 'requires_action') await openCheckoutTab(chrome.tabs, checkout);
    return checkout.status === 'complete' ? { checkout, entitlements: await sdk.getEntitlements() } : { checkout };
  }
  if (message.type === 'portal') {
    await openBillingPortalTab(chrome.tabs, await sdk.openBillingPortal({ returnUrl: activeConfig.returnURL }));
    return { opened: true };
  }
  if (!['configure', 'refresh'].includes(message.type)) throw new Error('Unsupported action.');
  const [entitlements, offerings, subscriptions] = await Promise.all([sdk.getEntitlements(), sdk.getOfferings(), sdk.getSubscriptions()]);
  // The latest attempt of each package, read again. An attempt that is over is forgotten.
  const checkouts = await Promise.all((offerings.current?.packages ?? []).map((pkg) => sdk.getPurchase(pkg.id)));
  return { customer, entitlements, offerings, subscriptions, checkout: checkouts.find(Boolean) ?? null };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Content scripts and other extensions cannot choose customers, tokens, URLs or actions.
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return false;
  const operation = queue.then(() => handle(message));
  queue = operation.catch(() => {});
  operation.then((result) => respond({ result }), (error) => respond({ error: { code: error.code, message: error.message } }));
  return true;
});
