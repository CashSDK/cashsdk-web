import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Type-check snippets against the built declarations, the way an app's compiler sees them.
const here = dirname(fileURLToPath(import.meta.url));
const options = {
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  jsx: ts.JsxEmit.ReactJSX,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2022,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  types: [],
};

function check(files) {
  const sources = new Map(files.map(([name, text]) => [join(here, name), text]));
  const host = ts.createCompilerHost(options);
  const { getSourceFile, fileExists, readFile } = host;
  host.getSourceFile = (name, version, ...rest) =>
    sources.has(name)
      ? ts.createSourceFile(name, sources.get(name), version)
      : getSourceFile.call(host, name, version, ...rest);
  host.fileExists = (name) => sources.has(name) || fileExists.call(host, name);
  host.readFile = (name) => sources.get(name) ?? readFile.call(host, name);
  const program = ts.createProgram([...sources.keys()], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .map((item) => `${item.file?.fileName.split("/").pop() ?? ""}: ${ts.flattenDiagnosticMessageText(item.messageText, "\n")}`);
}

test("every tsx snippet in the README type-checks", () => {
  const readme = readFileSync(join(here, "../README.md"), "utf8");
  const blocks = [...readme.matchAll(/```tsx\n([\s\S]*?)```/g)].map((match) => match[1]);
  assert(blocks.length >= 3);
  assert.deepEqual(check(blocks.map((code, index) => [`readme-${index}.tsx`, code])), []);
});

test("hook errors carry the CashSDKError code, as the docs use it", () => {
  const docs = `
"use client";
import { useBillingPortal } from "cashsdk-react";
export function ManageBilling() {
  const portal = useBillingPortal();
  return (
    <>
      <button
        disabled={portal.status === "starting"}
        onClick={async () => {
          const { url } = await portal.start({ returnUrl: \`\${location.origin}/account\` });
          location.assign(url);
        }}
      >
        Manage billing
      </button>
      {portal.error?.code === "no_billing_account" && <p>You have no paid plan yet.</p>}
    </>
  );
}
`;
  const every = `
import type { CashSDKError } from "cashsdk-web";
import { useBillingPortal, useCashSDKState, useCheckout, useCustomer, useEntitlements, useOfferings, usePurchase, useSubscriptions } from "cashsdk-react";
export function Codes() {
  const errors: (CashSDKError | null)[] = [
    useBillingPortal().error, useCheckout().error, usePurchase().error, useCustomer().error,
    useEntitlements().error, useOfferings().error, useSubscriptions().error, useCashSDKState().error,
  ];
  const codes: (string | undefined)[] = errors.map((error) => error?.code);
  const retry: boolean | undefined = usePurchase().error?.retryable;
  return <p>{codes.join(",")}{String(retry)}</p>;
}
`;
  assert.deepEqual(check([["docs-billing.tsx", docs], ["every-hook.tsx", every]]), []);
  // And a code that does not exist on the type is still an error, so the check is real.
  const wrong = check([["wrong.tsx", `import { usePurchase } from "cashsdk-react";\nexport const x = usePurchase().error?.cod;\n`]]);
  assert.equal(wrong.length, 1);
  assert.match(wrong[0], /cod/);
});
