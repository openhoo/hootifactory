import { env } from "@hootifactory/config";
import {
  type CryptoKey,
  exportJWK,
  generateKeyPair,
  importPKCS8,
  importSPKI,
  jwtVerify,
  SignJWT,
} from "jose";
import { z } from "zod";

import type { RegistryAccess } from "./principal";

export type { RegistryAccess };

/**
 * The registry token service name, used as the JWT audience when minting and
 * verifying registry bearer tokens and advertised in module auth challenges.
 */
export const REGISTRY_TOKEN_SERVICE = "hootifactory";

// Validate the wire shape of the access claim instead of trusting a cast: a
// malformed claim degrades to deny-all rather than throwing a TypeError deep
// inside the authorization decision (can.ts iterates `a.actions.includes(...)`).
const RegistryAccessSchema = z.array(
  z.object({ type: z.string(), name: z.string(), actions: z.array(z.string()) }),
);

interface Keys {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  kid: string;
}

let keysPromise: Promise<Keys> | null = null;

async function getKeys(): Promise<Keys> {
  if (!keysPromise) {
    keysPromise = (async () => {
      if (env.REGISTRY_JWT_PRIVATE_KEY && env.REGISTRY_JWT_PUBLIC_KEY) {
        const privateKey = (await importPKCS8(env.REGISTRY_JWT_PRIVATE_KEY, "RS256")) as CryptoKey;
        const publicKey = (await importSPKI(env.REGISTRY_JWT_PUBLIC_KEY, "RS256")) as CryptoKey;
        return { privateKey, publicKey, kid: "configured" };
      }
      // No configured keypair — generate an ephemeral one. This is fine for a
      // single-process dev/test run, but tokens won't verify across replicas and
      // are invalidated on restart. Production is already required to set the keys
      // (enforced by the config schema); warn loudly for any other environment.
      if (env.NODE_ENV !== "test") {
        console.warn(
          "[registry-jwt] REGISTRY_JWT_PRIVATE_KEY/PUBLIC_KEY unset — using an EPHEMERAL keypair. " +
            "Delegated registry bearer tokens will not survive restarts and are invalid across multiple API replicas.",
        );
      }
      const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
      return { privateKey, publicKey, kid: "ephemeral" };
    })();
  }
  return keysPromise;
}

export interface IssueTokenOptions {
  subject: string;
  access: RegistryAccess[];
  audience: string; // the registry service name
  ttlSeconds?: number;
}

export async function issueRegistryToken(opts: IssueTokenOptions): Promise<string> {
  const { privateKey, kid } = await getKeys();
  const ttl = opts.ttlSeconds ?? env.REGISTRY_JWT_TTL;
  return new SignJWT({ access: opts.access })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuedAt()
    .setIssuer(env.REGISTRY_PUBLIC_URL)
    .setAudience(opts.audience)
    .setSubject(opts.subject)
    .setExpirationTime(`${ttl}s`)
    .sign(privateKey);
}

export interface VerifiedRegistryToken {
  subject?: string;
  access: RegistryAccess[];
}

export async function verifyRegistryToken(
  token: string,
  audience?: string,
): Promise<VerifiedRegistryToken> {
  const { publicKey } = await getKeys();
  const { payload } = await jwtVerify(token, publicKey, {
    issuer: env.REGISTRY_PUBLIC_URL,
    audience,
    algorithms: ["RS256"], // pin the algorithm (defense-in-depth against alg confusion)
  });
  return {
    subject: payload.sub,
    access: RegistryAccessSchema.safeParse(payload.access).data ?? [],
  };
}

/** Public JWKS for clients/peers to verify registry tokens. */
export async function registryJwks(): Promise<{ keys: Record<string, unknown>[] }> {
  const { publicKey, kid } = await getKeys();
  const jwk = await exportJWK(publicKey);
  return { keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] };
}
