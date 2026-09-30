// Pack all three packages, check what each tarball contains, install them into an empty
// project with no network and no workspace links, and import and render them there.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const names = ["cashsdk-web", "cashsdk-react", "cashsdk-node"];
const versions = await Promise.all(
  names.map(async (name) => JSON.parse(await readFile(join(root, "packages", name, "package.json"), "utf8")).version),
);
assert(versions.every((version) => version === versions[0]), "The three packages are released together, at one version");
const version = versions[0];
const artifacts = await mkdtemp(join(tmpdir(), "cashsdk-packages-"));
execFileSync("pnpm", ["-r", "--filter", "./packages/*", "exec", "pnpm", "pack", "--pack-destination", artifacts], { cwd: root, stdio: "pipe" });
const dependencies = {};
for (const name of names) {
  const tarball = join(artifacts, `${name}-${version}.tgz`);
  const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n");
  for (const entry of entries) {
    assert(!entry.includes(".."), `Unsafe archive path: ${entry}`);
    assert(
      /^package\/(?:package\.json|README\.md|LICENSE|dist\/[\w./-]+\.(?:js|js\.map|d\.ts|d\.ts\.map)|src\/[\w./-]+\.tsx?)$/.test(entry),
      `Unexpected package file: ${entry}`,
    );
  }
  const pkg = JSON.parse(execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" }));
  assert.equal(pkg.name, name);
  assert.equal(pkg.version, version);
  assert.equal(pkg.license, "MIT");
  assert(!pkg.scripts?.preinstall && !pkg.scripts?.install && !pkg.scripts?.postinstall, "No install scripts");
  assert(!JSON.stringify(pkg.dependencies ?? {}).includes("workspace:"), "Packed dependencies must use registry versions");
  for (const [dependency, range] of Object.entries(pkg.dependencies ?? {})) {
    assert(names.includes(dependency), `Unexpected runtime dependency ${dependency}`);
    assert.equal(range, version, `${name} must depend on exactly ${dependency}@${version}`);
  }
  dependencies[name] = `file:${tarball}`;
}

const consumer = await mkdtemp(join(tmpdir(), "cashsdk-web-package-check-"));
try {
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies,
    }),
  );
  execFileSync(
    "npm",
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--legacy-peer-deps",
      "--no-audit",
      "--no-fund",
      "--cache",
      join(consumer, "npm-cache"),
    ],
    { cwd: consumer, stdio: "pipe" },
  );
  // Reuse installed third-party runtimes as SSR fixtures. Every CashSDK package above
  // is installed from its tarball; no source/workspace link can satisfy those imports.
  const peerRequire = createRequire(
    join(root, "packages/cashsdk-react/package.json"),
  );
  for (const peer of ["react", "react-dom"])
    await symlink(
      dirname(peerRequire.resolve(`${peer}/package.json`)),
      join(consumer, "node_modules", peer),
      "dir",
    );
  await writeFile(
    join(consumer, "smoke.mjs"),
    `
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createCashSDK } from "cashsdk-web";
import { CashSDKServer, verifyWebhook } from "cashsdk-node";
import { CashSDKProvider, useCashSDKState } from "cashsdk-react";
let calls = 0;
const client = createCashSDK({ publishableKey: "csk_pk_" + "p".repeat(32), environment: "sandbox", getSessionToken: async () => { calls++; throw new Error("SSR must not authenticate"); } });
function Status() { return createElement("span", null, useCashSDKState().status); }
assert.equal(renderToString(createElement(CashSDKProvider, { client }, createElement(Status))), "<span>idle</span>");
assert.equal(calls, 0);
assert.equal(typeof new CashSDKServer({ secretKey: "csk_sk_test_" + "s".repeat(32), environment: "sandbox" }).createWebSession, "function");
assert.equal(typeof verifyWebhook, "function");
client.destroy();
console.log("Three installed SDK tarballs import and render without network or customer state.");
`,
  );
  execFileSync(process.execPath, ["smoke.mjs"], {
    cwd: consumer,
    stdio: "inherit",
  });
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally {
  await rm(consumer, { recursive: true, force: true });
  await rm(artifacts, { recursive: true, force: true });
}
