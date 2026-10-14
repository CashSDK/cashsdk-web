import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createExtensionCashSDK, extensionOrigin, openCheckoutTab, openBillingPortalTab } from '../dist/extension.js';
const id = 'a'.repeat(32);
const runtime = { id, getURL: () => `chrome-extension://${id}/` };
const at = (origin, work) => {
  globalThis.location = { origin };
  try { return work(); } finally { delete globalThis.location; }
};

test('extension origins are exact and reject web/content-script origins', () => {
  assert.equal(extensionOrigin(runtime), `chrome-extension://${id}`);
  for (const value of [undefined, '', 'x'.repeat(32), '../', 'a'.repeat(31)])
    assert.throws(() => extensionOrigin({ ...runtime, id: value }));
  assert.throws(() => extensionOrigin({ ...runtime, getURL: () => 'https://attacker.example/' }));
  // An extension page or the service worker runs on the extension's own origin.
  assert.equal(at(`chrome-extension://${id}`, () => extensionOrigin(runtime)), `chrome-extension://${id}`);
  // A content script reads the same chrome.runtime, on the web page's origin.
  for (const origin of ['https://shop.example', 'null', `chrome-extension://${'b'.repeat(32)}`])
    assert.throws(() => at(origin, () => extensionOrigin(runtime)), (error) => error.code === 'invalid_configuration' && /content script/.test(error.message));
  assert.throws(() => at('https://shop.example', () => createExtensionCashSDK({
    runtime, publishableKey: 'csk_pk_example', environment: 'sandbox', getSessionToken: async () => '',
  })), { code: 'invalid_configuration' });
});

test('worker client sends explicit origin with session auth, without DOM or cookies', async () => {
  const client = createExtensionCashSDK({
    runtime, publishableKey: 'csk_pk_example', environment: 'sandbox',
    getSessionToken: async () => `csk_ws_${'x'.repeat(43)}`,
    fetch: async (url, init) => {
      assert.equal(new Headers(init.headers).get('x-cashsdk-client-origin'), `chrome-extension://${id}`);
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer csk_pk_example');
      assert.equal(init.credentials, 'omit');
      assert.equal(init.redirect, 'error');
      return Response.json({ customerId: 'alice', environment: 'sandbox' });
    },
  });
  assert.equal((await client.getCustomer()).customerId, 'alice');
  client.destroy();
});

test('tabs open Stripe only and never treat pending or complete as a payment redirect', async () => {
  const opened = [];
  const tabs = { create: async (properties) => { opened.push(properties); } };
  const checkout = { status: 'requires_action', action: { type: 'redirect', url: 'https://checkout.stripe.com/c/pay/example' } };
  await openCheckoutTab(tabs, checkout);
  await openBillingPortalTab(tabs, { url: 'https://billing.stripe.com/p/session/example' });
  // A Stripe custom domain serves the same pages under the same paths.
  await openCheckoutTab(tabs, { ...checkout, action: { type: 'redirect', url: 'https://pay.merchant.example/c/pay/example' } });
  await openBillingPortalTab(tabs, { url: 'https://billing.merchant.example/p/session/example' });
  assert.deepEqual(opened.map((tab) => tab.url), [
    'https://checkout.stripe.com/c/pay/example',
    'https://billing.stripe.com/p/session/example',
    'https://pay.merchant.example/c/pay/example',
    'https://billing.merchant.example/p/session/example',
  ]);
  assert(opened.every((tab) => tab.active === true));
  for (const url of ['https://attacker.example', 'https://attacker.example/pay/x', 'javascript:alert(1)', 'https://checkout.stripe.com@evil.example/', 'http://checkout.stripe.com', 'https://checkout.stripe.com:444/', 'https://127.0.0.1/c/pay/x', 'https://localhost/c/pay/x', 'https://pay.merchant.example/p/session/x'])
    await assert.rejects(openCheckoutTab(tabs, { ...checkout, action: { ...checkout.action, url } }), { code: 'invalid_response' }, url);
  for (const url of ['https://billing.merchant.example/c/pay/x', 'http://billing.stripe.com/p/session/x', 'https://10.0.0.1/p/session/x', null])
    await assert.rejects(openBillingPortalTab(tabs, { url }), { code: 'invalid_response' }, String(url));
  for (const status of ['pending', 'complete', 'failed'])
    await assert.rejects(openCheckoutTab(tabs, { ...checkout, status }));
  assert.equal(opened.length, 4);
});
