// Do not disable JWT verification or log credentials.
import { createClient } from "jsr:@supabase/supabase-js@2.119.0";
import {
  createRemoteJWKSet,
  importPKCS8,
  jwtVerify,
  SignJWT,
} from "npm:jose@5.9.6";

const appleKeys = createRemoteJWKSet(
  new URL("https://appleid.apple.com/auth/keys"),
);
const json = (status: number, body: object) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
const error = (status: number, message: string) =>
  json(status, { error: message });

async function revokeApple(
  code: string | undefined,
  clientID: string,
  subject: string,
): Promise<boolean> {
  const team = Deno.env.get("APPLE_TEAM_ID");
  const keyID = Deno.env.get("APPLE_SIGN_IN_KEY_ID");
  const privateKey = Deno.env.get("APPLE_SIGN_IN_PRIVATE_KEY");
  if (!code || !team || !keyID || !privateKey) return false;
  try {
    const key = await importPKCS8(privateKey.replaceAll("\\n", "\n"), "ES256");
    const secret = await new SignJWT({}).setProtectedHeader({
      alg: "ES256",
      kid: keyID,
    })
      .setIssuer(team).setSubject(clientID).setAudience(
        "https://appleid.apple.com",
      )
      .setIssuedAt().setExpirationTime("5m").sign(key);
    const exchange = await fetch("https://appleid.apple.com/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientID,
        client_secret: secret,
        code,
        grant_type: "authorization_code",
      }),
    });
    if (!exchange.ok) return false;
    const tokens = await exchange.json() as {
      id_token?: string;
      refresh_token?: string;
      access_token?: string;
    };
    if (!tokens.id_token || (!tokens.refresh_token && !tokens.access_token)) {
      return false;
    }
    const { payload } = await jwtVerify(tokens.id_token, appleKeys, {
      issuer: "https://appleid.apple.com",
      audience: clientID,
      algorithms: ["RS256"],
    });
    if (payload.sub !== subject) return false;
    const revoke = await fetch("https://appleid.apple.com/auth/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientID,
        client_secret: secret,
        token: tokens.refresh_token ?? tokens.access_token!,
        token_type_hint: tokens.refresh_token
          ? "refresh_token"
          : "access_token",
      }),
    });
    return revoke.ok;
  } catch {
    return false;
  }
}

export async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== "POST") return error(405, "Method not allowed");
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const clientID = Deno.env.get("APPLE_SIGN_IN_CLIENT_ID") ??
    "org.nando.Papa-PriceChecker";
  if (!url || !anonKey || !serviceKey) {
    return error(503, "Account deletion is not configured");
  }
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) {
    return error(401, "Authentication required");
  }
  try {
    const client = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error: authError } = await client.auth.getUser(
      header.slice(7),
    );
    if (authError || !user) return error(401, "Authentication required");
    const subject = user.identities?.find((identity) =>
      identity.provider === "apple"
    )?.identity_data?.sub;
    if (typeof subject !== "string" || !subject) {
      return error(403, "An Apple account is required");
    }
    let body: {
      identity_token?: unknown;
      nonce?: unknown;
      authorization_code?: unknown;
    };
    try {
      body = await request.json();
    } catch {
      return error(400, "Invalid request");
    }
    if (
      typeof body?.identity_token !== "string" ||
      body.identity_token.length > 16384 ||
      typeof body.nonce !== "string" || !/^[a-f0-9]{64}$/.test(body.nonce)
    ) {
      return error(400, "Fresh Apple authorization required");
    }
    let payload;
    try {
      ({ payload } = await jwtVerify(body.identity_token, appleKeys, {
        issuer: "https://appleid.apple.com",
        audience: clientID,
        algorithms: ["RS256"],
        maxTokenAge: "5m",
      }));
    } catch {
      return error(403, "Apple authorization could not be verified");
    }
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(body.nonce),
    );
    const hashedNonce = Array.from(
      new Uint8Array(hash),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    if (payload.sub !== subject || payload.nonce !== hashedNonce) {
      return error(403, "Apple account does not match");
    }
    const code = typeof body.authorization_code === "string" &&
        body.authorization_code.length <= 4096
      ? body.authorization_code
      : undefined;
    const appleRevoked = await revokeApple(code, clientID, subject);
    const admin = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error: deletionError } = await admin.auth.admin.deleteUser(user.id);
    if (deletionError) {
      return error(503, "Account deletion could not be completed");
    }
    return json(200, { ok: true, apple_revoked: appleRevoked });
  } catch {
    return error(500, "Account deletion could not be completed");
  }
}
if (import.meta.main) Deno.serve(handleRequest);
