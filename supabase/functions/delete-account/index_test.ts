import {
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  SignJWT,
} from "npm:jose@5.9.6";
import { handleRequest } from "./index.ts";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};
const fakeUser = "11111111-1111-1111-1111-111111111111";
const clientID = "org.nando.Papa-PriceChecker";
const team = "TEAM123456";
const appleSubject = "apple-user-a";

Deno.test("delete-account requires matching fresh Apple authorization and deletes even if revocation fails", async () => {
  const signing = await generateKeyPair("ES256", { extractable: true });
  const apple = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(apple.publicKey);
  jwk.kid = "apple-test-key";
  jwk.alg = "RS256";
  jwk.use = "sig";
  const env: Record<string, string> = {
    SUPABASE_URL: "https://project.example.test",
    SUPABASE_ANON_KEY: "public-test-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
    APPLE_TEAM_ID: team,
    APPLE_SIGN_IN_KEY_ID: "KEY123",
    APPLE_SIGN_IN_CLIENT_ID: clientID,
    APPLE_SIGN_IN_PRIVATE_KEY: await exportPKCS8(signing.privateKey),
  };
  for (const [key, value] of Object.entries(env)) Deno.env.set(key, value);
  let subject = appleSubject;
  const nonce = "a".repeat(64);
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(nonce),
  );
  const hashedNonce = Array.from(
    new Uint8Array(hash),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  const identityToken = async (sub: string, claim = hashedNonce) =>
    await new SignJWT({ nonce: claim }).setProtectedHeader({
      alg: "RS256",
      kid: "apple-test-key",
    }).setIssuer("https://appleid.apple.com").setAudience(clientID).setSubject(
      sub,
    ).setIssuedAt().setExpirationTime("5m").sign(apple.privateKey);
  let revokeOK = true;
  let adminDeletes = 0;
  let revokes = 0;
  const seen: string[] = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    seen.push(`${request.method} ${url.host}${url.pathname}`);
    if (
      url.host === "project.example.test" && url.pathname === "/auth/v1/user"
    ) {
      if (request.headers.get("Authorization") !== "Bearer test-user-token") {
        return Response.json({ message: "invalid token" }, { status: 401 });
      }
      return Response.json({
        id: fakeUser,
        identities: [{
          provider: "apple",
          identity_data: { sub: appleSubject },
        }],
      });
    }
    if (url.host === "appleid.apple.com" && url.pathname === "/auth/token") {
      const idToken = await new SignJWT({}).setProtectedHeader({
        alg: "RS256",
        kid: "apple-test-key",
      })
        .setIssuer("https://appleid.apple.com").setAudience(clientID)
        .setSubject(subject)
        .setIssuedAt().setExpirationTime("5m").sign(apple.privateKey);
      return Response.json({
        id_token: idToken,
        refresh_token: "fake-apple-refresh-token",
      });
    }
    if (url.host === "appleid.apple.com" && url.pathname === "/auth/keys") {
      return Response.json({ keys: [jwk] });
    }
    if (url.host === "appleid.apple.com" && url.pathname === "/auth/revoke") {
      revokes++;
      return new Response("", { status: revokeOK ? 200 : 500 });
    }
    if (
      url.host === "project.example.test" &&
      url.pathname === `/auth/v1/admin/users/${fakeUser}`
    ) {
      if (request.method === "GET") return Response.json({ id: fakeUser });
      if (request.method === "DELETE") {
        adminDeletes++;
        return Response.json({});
      }
    }
    throw new Error(
      `Unexpected test request: ${request.method} ${url.host}${url.pathname}`,
    );
  }) as typeof fetch;
  const request = (token: string, body: unknown) =>
    new Request("https://function.example.test", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  try {
    let response = await handleRequest(
      request("invalid", { authorization_code: "fresh-code" }),
    );
    assert(
      response.status === 401 && adminDeletes === 0,
      "invalid session was accepted",
    );
    response = await handleRequest(request("test-user-token", {}));
    assert(
      response.status === 400 && adminDeletes === 0,
      "missing Apple code was accepted",
    );
    const body = {
      authorization_code: "fresh-code",
      nonce,
      identity_token: await identityToken("different-apple-user"),
    };
    response = await handleRequest(request("test-user-token", body));
    assert(
      response.status === 403 && revokes === 0 && adminDeletes === 0,
      "different account accepted",
    );
    body.identity_token = await identityToken(appleSubject, "wrong-nonce");
    response = await handleRequest(request("test-user-token", body));
    assert(
      response.status === 403 && adminDeletes === 0,
      "wrong nonce accepted",
    );
    body.identity_token = await identityToken(appleSubject);
    revokeOK = false;
    response = await handleRequest(request("test-user-token", body));
    assert(
      response.status === 200 && !(await response.json()).apple_revoked &&
        adminDeletes === 1,
      "failed revocation must still delete account",
    );
    revokeOK = true;
    response = await handleRequest(request("test-user-token", body));
    assert(
      response.status === 200 && (await response.json()).apple_revoked &&
        adminDeletes === 2,
      `valid deletion failed: ${seen.join(";")}`,
    );
    subject = "different-apple-user";
    response = await handleRequest(request("test-user-token", body));
    assert(
      response.status === 200 && !(await response.json()).apple_revoked &&
        adminDeletes === 3 && revokes === 2,
      "different exchanged account must not be revoked",
    );
  } finally {
    globalThis.fetch = oldFetch;
    for (const key of Object.keys(env)) Deno.env.delete(key);
  }
});
