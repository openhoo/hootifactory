import { timingSafeEqual } from "node:crypto";
import type { SignedOidcState } from "./oidc-types";

function hmacHex(secret: string, body: string): string {
  const h = new Bun.CryptoHasher("sha256", secret);
  h.update(body);
  return h.digest("hex");
}

export function safeOidcReturnTo(value: string | null | undefined): string {
  if (!value) return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const parsed = new URL(value, "http://hootifactory.local");
    if (parsed.origin !== "http://hootifactory.local") return "/";
    return `${parsed.pathname}${parsed.search}${parsed.hash}` || "/";
  } catch {
    return "/";
  }
}

export function signOidcState(payload: SignedOidcState, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${hmacHex(secret, body)}`;
}

export function verifyOidcState(
  value: string | undefined,
  secret: string,
  now = Date.now(),
): SignedOidcState | null {
  const [body, sig, extra] = value?.split(".") ?? [];
  if (!body || !sig || extra !== undefined) return null;
  const expected = hmacHex(secret, body);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isSignedOidcState(parsed) || parsed.expiresAt < now) return null;
  return parsed;
}

function isSignedOidcState(value: unknown): value is SignedOidcState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.state === "string" &&
    typeof v.nonce === "string" &&
    typeof v.codeVerifier === "string" &&
    typeof v.returnTo === "string" &&
    typeof v.expiresAt === "number"
  );
}
