import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { CashSDKServer } from "../../packages/cashsdk-node/dist/index.js";

// This login is an isolated local test fixture. Production apps supply their own identity provider.
if (process.env.NODE_ENV === "production")
  throw new Error("The local example login must not run in production");
const port = Number(process.env.EXAMPLE_PORT ?? 3000);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid EXAMPLE_PORT");
const origin = `http://localhost:${port}`;
const password = process.env.EXAMPLE_PASSWORD;
const customerId = process.env.EXAMPLE_CUSTOMER_ID;
const publishableKey = process.env.CASHSDK_PUBLISHABLE_KEY;
const secretKey = process.env.CASHSDK_SECRET_KEY;
const apiUrl = process.env.CASHSDK_API_URL ?? "https://api.cashsdk.com";
if (
  !password ||
  password.length < 16 ||
  !customerId ||
  !publishableKey ||
  !secretKey
)
  throw new Error(
    "Set EXAMPLE_PASSWORD (16+ characters), EXAMPLE_CUSTOMER_ID, CASHSDK_PUBLISHABLE_KEY and CASHSDK_SECRET_KEY",
  );
const cashsdk = new CashSDKServer({
  secretKey,
  environment: "sandbox",
  apiUrl,
});
const hash = (value) => createHash("sha256").update(value).digest();
const sessions = new Map();
let loginAttempts = 0;
let loginWindow = Date.now();
const staticFiles = new Map([
  ["/", ["./index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["./app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["./style.css", "text/css; charset=utf-8"]],
  [
    "/sdk/index.js",
    [
      "../../packages/cashsdk-web/dist/index.js",
      "text/javascript; charset=utf-8",
    ],
  ],
  [
    "/sdk/http.js",
    [
      "../../packages/cashsdk-web/dist/http.js",
      "text/javascript; charset=utf-8",
    ],
  ],
]);

const server = createServer(async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; connect-src 'self' ${new URL(apiUrl).origin}; frame-ancestors 'none'; form-action 'self'; base-uri 'none'`,
  );
  const json = (status, data) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(data));
  };
  try {
    const path = new URL(request.url, origin).pathname;
    if (request.method === "GET" && staticFiles.has(path)) {
      const [file, type] = staticFiles.get(path);
      response.writeHead(200, { "Content-Type": type });
      response.end(await readFile(new URL(file, import.meta.url)));
      return;
    }
    if (request.method === "GET" && path === "/configuration") {
      json(200, {
        publishableKey,
        apiUrl,
        connectionId: process.env.CASHSDK_STRIPE_CONNECTION_ID ?? null,
      });
      return;
    }
    if (request.method !== "POST" || request.headers.origin !== origin) {
      json(403, { message: "This example requires a same-origin POST" });
      return;
    }
    if (path === "/login") {
      if (Date.now() - loginWindow > 60000) {
        loginAttempts = 0;
        loginWindow = Date.now();
      }
      if (++loginAttempts > 20) {
        json(429, { message: "Wait a minute before trying again" });
        return;
      }
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > 4096) {
          json(413, { message: "Request too large" });
          return;
        }
      }
      let input;
      try {
        input = JSON.parse(body);
      } catch {
        json(400, { message: "Invalid JSON" });
        return;
      }
      if (
        typeof input.password !== "string" ||
        !timingSafeEqual(hash(input.password), hash(password))
      ) {
        json(401, { message: "Incorrect example password" });
        return;
      }
      for (const [key, session] of sessions)
        if (session.expiresAt < Date.now()) sessions.delete(key);
      const token = randomBytes(32).toString("base64url");
      sessions.set(token, { customerId, expiresAt: Date.now() + 3600000 });
      response.setHeader(
        "Set-Cookie",
        `cashsdk_example=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`,
      );
      json(200, { signedIn: true });
      return;
    }
    const token = request.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("cashsdk_example="))
      ?.slice("cashsdk_example=".length);
    const session = sessions.get(token);
    if (path === "/logout") {
      // Every tab holds its own CashSDK session. Signing out ends all of them.
      if (session)
        await cashsdk.revokeWebSessions(session.customerId).catch(() => {
          /* They expire within ten minutes. Sign-out itself must still succeed. */
        });
      sessions.delete(token);
      response.setHeader(
        "Set-Cookie",
        "cashsdk_example=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
      );
      json(200, { signedOut: true });
      return;
    }
    if (!session || session.expiresAt <= Date.now()) {
      json(401, { message: "Sign in first" });
      return;
    }
    if (path === "/api/cashsdk/session") {
      json(
        200,
        await cashsdk.createWebSession({
          customerId: session.customerId,
          origin,
          scopes: [
            "customer:read",
            "entitlements:read",
            "subscriptions:read",
            "offerings:read",
            "checkout:create",
            "checkout:read",
          ],
        }),
      );
      return;
    }
    if (path === "/api/protected") {
      const access = await cashsdk.getEntitlements(session.customerId);
      if (!access.entitlements.some((item) => item.identifier === "pro")) {
        json(403, { message: "Pro access is required" });
        return;
      }
      json(200, { message: "The backend verified your Pro entitlement" });
      return;
    }
    json(404, { message: "Not found" });
  } catch {
    json(502, {
      message:
        "The example could not complete this request. Check the local service configuration.",
    });
  }
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.listen(port, "127.0.0.1", () => {
  console.log(`CashSDK sandbox example: ${origin}`);
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => server.close());
