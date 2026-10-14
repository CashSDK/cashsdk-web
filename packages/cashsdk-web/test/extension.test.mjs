import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createExtensionCashSDK, extensionOrigin, openCheckoutTab, openBillingPortalTab } from '../dist/extension.js';
const id = 'a'.repeat(32);
const runtime = { id, getURL: () => `chrome-extension://${id}/` };

test('extension origins are exact and reject web/content-script origins', () => {
  assert.equal(extensionOrigin(runtime), `chrome-extension://${id}`);
  for (const value of [undefined, '', 'x'.repeat(32), '../', 'a'.repeat(31)])
    assert.throws(() => extensionOrigin({ ...runtime, id: value }));
  assert.throws(() => extensionOrigin({ ...runtime, getURL: () => 'https://attacker.example/' }));
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
  assert.equal(opened.length, 2);
  for (const url of ['https://attacker.example', 'javascript:alert(1)', 'https://checkout.stripe.com@evil.example/', 'http://checkout.stripe.com', 'https://checkout.stripe.com:444/'])
    await assert.rejects(openCheckoutTab(tabs, { ...checkout, action: { ...checkout.action, url } }));
  for (const status of ['pending', 'complete', 'failed'])
    await assert.rejects(openCheckoutTab(tabs, { ...checkout, status }));
  assert.equal(opened.length, 2);
});
