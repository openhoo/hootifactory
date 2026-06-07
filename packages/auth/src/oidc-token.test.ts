import { afterEach, describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { verifyIdToken } from "./oidc-token";

const ISSUER = "https://idp.oidc-token.test";
const CLIENT_ID = "client-abc";
// A unique JWKS URI per assertion avoids jose's in-process remote-JWKS cache
// returning a stale key across cases.
let uriCounter = 0;
const nextJwksUri = () => `${ISSUER}/jwks/${uriCounter++}`;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function setupKeysAndJwks() {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  const jwksUri = nextJwksUri();
  const jwksBody = JSON.stringify({ keys: [{ ...jwk, alg: "RS256", use: "sig", kid: "k1" }] });
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === jwksUri) {
      return new Response(jwksBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
  return { privateKey, jwksUri };
}

function sign(privateKey: CryptoKey, claims: Record<string, unknown>) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .setSubject("subject-1")
    .setExpirationTime("5m")
    .sign(privateKey);
}

describe("verifyIdToken", () => {
  test("verifies a well-formed id_token and returns its claims", async () => {
    const { privateKey, jwksUri } = await setupKeysAndJwks();
    const idToken = await sign(privateKey, { email: "a@b.test", nonce: "n1" });
    const claims = await verifyIdToken(idToken, {
      issuer: ISSUER,
      clientId: CLIENT_ID,
      jwksUri,
      nonce: "n1",
    });
    expect(claims.sub).toBe("subject-1");
    expect(claims.email).toBe("a@b.test");
  });

  test("accepts a token when no nonce expectation is supplied", async () => {
    const { privateKey, jwksUri } = await setupKeysAndJwks();
    const idToken = await sign(privateKey, { email: "a@b.test" });
    const claims = await verifyIdToken(idToken, { issuer: ISSUER, clientId: CLIENT_ID, jwksUri });
    expect(claims.sub).toBe("subject-1");
  });

  test("rejects a nonce mismatch", async () => {
    const { privateKey, jwksUri } = await setupKeysAndJwks();
    const idToken = await sign(privateKey, { nonce: "actual" });
    await expect(
      verifyIdToken(idToken, { issuer: ISSUER, clientId: CLIENT_ID, jwksUri, nonce: "expected" }),
    ).rejects.toThrow("nonce mismatch");
  });

  test("rejects a token signed for the wrong audience", async () => {
    const { privateKey, jwksUri } = await setupKeysAndJwks();
    const idToken = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience("some-other-client")
      .setSubject("subject-1")
      .setExpirationTime("5m")
      .sign(privateKey);
    await expect(
      verifyIdToken(idToken, { issuer: ISSUER, clientId: CLIENT_ID, jwksUri }),
    ).rejects.toThrow();
  });
});
