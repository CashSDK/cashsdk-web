// After a release: install the published versions into an empty project the way a
// customer would, check the registry signatures and provenance, and import each package.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const version = process.argv[2];
if (!version) throw new Error("Pass the published version");
const dir = mkdtempSync(join(tmpdir(), "cashsdk-published-"));
const run = (command, args) => execFileSync(command, args, { cwd: dir, stdio: "inherit" });
writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true, type: "module" }));
// The registry can take a minute to serve a new version everywhere.
for (let attempt = 1; ; attempt++) {
  try {
    run("npm", ["install", "--no-audit", "--no-fund", `cashsdk-web@${version}`, `cashsdk-react@${version}`, `cashsdk-node@${version}`, "react@19", "react-dom@19"]);
    break;
  } catch (error) {
    if (attempt === 10) throw error;
    execFileSync("sleep", ["30"]);
  }
}
run("npm", ["audit", "signatures"]);
writeFileSync(
  join(dir, "check.mjs"),
  `import { createCashSDK } from "cashsdk-web";
import { CashSDKProvider, useEntitlements } from "cashsdk-react";
import { CashSDKServer, verifyWebhook } from "cashsdk-node";
for (const value of [createCashSDK, CashSDKProvider, useEntitlements, CashSDKServer, verifyWebhook])
  if (typeof value !== "function") throw new Error("missing export");
console.log("The published packages import.");
`,
);
run("node", ["check.mjs"]);
