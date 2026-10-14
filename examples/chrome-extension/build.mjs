import { cp, mkdir } from 'node:fs/promises';
const target = new URL('./sdk/', import.meta.url);
await mkdir(target, { recursive: true });
for (const name of ['index.js', 'http.js', 'extension.js']) {
  await cp(new URL(`../../packages/cashsdk-web/dist/${name}`, import.meta.url), new URL(name, target));
}
console.log('Extension ready. Load examples/chrome-extension as an unpacked extension.');
