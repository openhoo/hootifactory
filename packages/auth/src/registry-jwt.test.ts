import { describe, expect, test } from "bun:test";
import { SignJWT } from "jose";
import { issueRegistryToken, registryJwks, verifyRegistryToken } from "./registry-jwt";

const AUDIENCE = "hootifactory-registry";

describe("registry JWT (RS256)", () => {
  test("issue -> verify round-trips subject and access claims", async () => {
    const jwt = await issueRegistryToken({
      subject: "alice",
      audience: AUDIENCE,
      access: [{ type: "repository", name: "acme/app", actions: ["pull", "push"] }],
    });
    const verified = await verifyRegistryToken(jwt, AUDIENCE);
    expect(verified.subject).toBe("alice");
    expect(verified.access[0]?.name).toBe("acme/app");
    expect(verified.access[0]?.actions).toEqual(["pull", "push"]);
  });

  test("registryJwks exposes a public RS256 signing key", async () => {
    const jwks = await registryJwks();
    expect(jwks.keys.length).toBeGreaterThan(0);
    const key = jwks.keys[0]!;
    expect(key.alg).toBe("RS256");
    expect(key.use).toBe("sig");
    expect(key.kty).toBe("RSA");
    // The public JWK must never carry the private exponent.
    expect(key.d).toBeUndefined();
  });

  test("verification rejects a token minted for a different audience", async () => {
    const jwt = await issueRegistryToken({ subject: "alice", audience: AUDIENCE, access: [] });
    await expect(verifyRegistryToken(jwt, "wrong-audience")).rejects.toThrow();
  });

  test("verification rejects an expired token", async () => {
    const jwt = await issueRegistryToken({
      subject: "alice",
      audience: AUDIENCE,
      access: [],
      ttlSeconds: -1,
    });
    await expect(verifyRegistryToken(jwt, AUDIENCE)).rejects.toThrow();
  });

  test("verification rejects an alg-confusion (HS256) forgery", async () => {
    const forged = await new SignJWT({ access: [] })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("http://localhost:3000")
      .setAudience(AUDIENCE)
      .setSubject("mallory")
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("attacker-secret"));
    await expect(verifyRegistryToken(forged, AUDIENCE)).rejects.toThrow();
  });

  test("verifying without an audience succeeds and returns the access claim", async () => {
    const jwt = await issueRegistryToken({
      subject: "bob",
      audience: AUDIENCE,
      access: [{ type: "repository", name: "x", actions: ["pull"] }],
    });
    const verified = await verifyRegistryToken(jwt);
    expect(verified.subject).toBe("bob");
    expect(Array.isArray(verified.access)).toBe(true);
    expect(verified.access[0]?.actions).toEqual(["pull"]);
  });
});
