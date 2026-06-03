import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
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

const SignedOidcStateSchema = z.strictObject({
  state: z.string().min(1).max(512),
  nonce: z.string().min(1).max(512),
  codeVerifier: z.string().min(1).max(512),
  returnTo: z
    .string()
    .min(1)
    .max(2048)
    .refine((value) => safeOidcReturnTo(value) === value, "unsafe return path"),
  expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

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
  const state = SignedOidcStateSchema.safeParse(parsed);
  if (!state.success || state.data.expiresAt < now) return null;
  return state.data;
}
