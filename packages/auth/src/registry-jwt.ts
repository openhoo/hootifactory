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

import type { RegistryAccess } from "./principal";

export type { RegistryAccess };

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
  });
  return {
    subject: payload.sub,
    access: (payload.access as RegistryAccess[] | undefined) ?? [],
  };
}

/** Public JWKS for clients/peers to verify registry tokens. */
export async function registryJwks(): Promise<{ keys: Record<string, unknown>[] }> {
  const { publicKey, kid } = await getKeys();
  const jwk = await exportJWK(publicKey);
  return { keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] };
}
