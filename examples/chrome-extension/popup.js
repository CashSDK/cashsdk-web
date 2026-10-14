const form = document.querySelector('#setup');
const status = document.querySelector('#status');
const plans = document.querySelector('#plans');
document.querySelector('#origin').textContent = `Allow this origin: chrome-extension://${chrome.runtime.id}`;
const { configuration } = await chrome.storage.local.get('configuration');
if (configuration) for (const [name, value] of Object.entries(configuration)) if (form.elements.namedItem(name)) form.elements.namedItem(name).value = value;
let busy = false;
async function send(message) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('button').forEach((button) => { button.disabled = true; });
  try {
    const response = await chrome.runtime.sendMessage(message);
    if (response.error) throw new Error(response.error.message);
    const result = response.result;
    status.textContent = result.signedOut ? 'Signed out.' : result.opened ? 'Billing opened in a new tab.' : result.checkout ? `Checkout: ${result.checkout.status}. Refresh access after payment.` : 'Access refreshed.';
    if (result.signedOut) { plans.replaceChildren(); document.querySelector('#access').textContent = ''; }
    if (result.entitlements) document.querySelector('#access').textContent = JSON.stringify(result.entitlements.entitlements, null, 2);
    if (result.offerings) {
      plans.replaceChildren();
      for (const pkg of result.offerings.current?.packages ?? []) {
        const button = document.createElement('button');
        button.textContent = pkg.product.displayName ?? pkg.identifier;
        button.dataset.purchasable = String(pkg.purchasable);
        button.addEventListener('click', () => void send({ type: 'buy', packageId: pkg.id }));
        plans.append(button);
      }
    }
  } catch (error) { status.textContent = error.message; }
  finally {
    busy = false;
    document.querySelectorAll('button').forEach((button) => { button.disabled = button.dataset.purchasable === 'false'; });
  }
}
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const { backendToken, ...configuration } = Object.fromEntries(new FormData(form));
  try {
    const origins = [configuration.apiUrl, configuration.backendSessionURL].map((url) => `${new URL(url).origin}/*`);
    if (!await chrome.permissions.request({ origins: [...new Set(origins)] })) throw new Error('Host permission is required to contact your backend and CashSDK.');
    await send({ type: 'configure', configuration, backendToken });
    form.elements.backendToken.value = '';
  } catch (error) { status.textContent = error.message; }
});
for (const type of ['refresh', 'portal', 'logout']) document.querySelector(`#${type}`).addEventListener('click', () => void send({ type }));
