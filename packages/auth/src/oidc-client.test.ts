import { afterEach, describe, expect, test } from "bun:test";
import { createOidcAuthorizationRequest, oidcClientConfig } from "./oidc-client";
import type { OidcProviderConfig } from "./oidc-types";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// A fresh issuer per test sidesteps the module-level discovery config cache so
// each case re-runs discovery against its own mocked fetch.
let issuerCounter = 0;
function freshIssuer(scheme: "http" | "https" = "https"): string {
  return `${scheme}://idp-${issuerCounter++}.oidc-client.test`;
}

function discoveryDoc(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    userinfo_endpoint: `${issuer}/userinfo`,
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
  };
}

function mockDiscovery(issuer: string, onWellKnown?: () => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/.well-known/openid-configuration")) {
      if (onWellKnown) return onWellKnown();
      return new Response(JSON.stringify(discoveryDoc(issuer)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
}

function config(issuer: string, overrides: Partial<OidcProviderConfig> = {}): OidcProviderConfig {
  return {
    issuer,
    clientId: "client-1",
    clientSecret: "secret-1",
    groupClaim: "groups",
    ...overrides,
  };
}

describe("oidcClientConfig", () => {
  test("throws without a client secret before issuing any request", async () => {
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      throw new Error("should not fetch");
    }) as unknown as typeof fetch;
    await expect(
      oidcClientConfig(config(freshIssuer(), { clientSecret: undefined })),
    ).rejects.toThrow("client secret is required");
    expect(fetched).toBe(false);
  });

  test("caches the discovered configuration so repeated calls discover once", async () => {
    const issuer = freshIssuer();
    let wellKnownCalls = 0;
    mockDiscovery(issuer, () => {
      wellKnownCalls += 1;
      return new Response(JSON.stringify(discoveryDoc(issuer)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const cfg = config(issuer);
    const first = await oidcClientConfig(cfg);
    const second = await oidcClientConfig(cfg);
    expect(first).toBe(second);
    expect(wellKnownCalls).toBe(1);
  });

  test("evicts a rejected discovery promise so a later call can retry", async () => {
    const issuer = freshIssuer();
    let calls = 0;
    mockDiscovery(issuer, () => {
      calls += 1;
      if (calls === 1) return new Response("nope", { status: 500 });
      return new Response(JSON.stringify(discoveryDoc(issuer)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const cfg = config(issuer);
    await expect(oidcClientConfig(cfg)).rejects.toBeDefined();
    // Drain the microtask queue so the eviction attached via `void cached.catch(...)`
    // runs before the retry; a few turns covers the rejection's microtask hops.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const recovered = await oidcClientConfig(cfg);
    expect(recovered).toBeDefined();
    expect(calls).toBe(2);
  });
});

describe("createOidcAuthorizationRequest", () => {
  test("builds a PKCE+nonce auth URL and a matching signed-state payload", async () => {
    const issuer = freshIssuer();
    mockDiscovery(issuer);
    const { url, state } = await createOidcAuthorizationRequest(
      config(issuer, { scopes: ["openid", "email"] }),
      "https://hoot.test/callback",
      "/repositories?x=1",
      120,
    );
    expect(url.toString().startsWith(`${issuer}/authorize`)).toBe(true);
    expect(url.searchParams.get("redirect_uri")).toBe("https://hoot.test/callback");
    expect(url.searchParams.get("scope")).toBe("openid email");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(state.state);
    expect(url.searchParams.get("nonce")).toBe(state.nonce);
    expect(state.returnTo).toBe("/repositories?x=1");
    expect(state.codeVerifier.length).toBeGreaterThan(0);
    expect(state.expiresAt).toBeGreaterThan(Date.now());
  });

  test("defaults scopes and sanitizes an unsafe returnTo", async () => {
    const issuer = freshIssuer();
    mockDiscovery(issuer);
    const { url, state } = await createOidcAuthorizationRequest(
      config(issuer),
      "https://hoot.test/callback",
      "https://evil.test/phish",
    );
    expect(url.searchParams.get("scope")).toBe("openid profile email groups");
    expect(state.returnTo).toBe("/");
  });

  test("allows insecure (http) issuers during discovery", async () => {
    const issuer = freshIssuer("http");
    mockDiscovery(issuer);
    const { url } = await createOidcAuthorizationRequest(
      config(issuer),
      "http://hoot.test/callback",
      "/",
    );
    expect(url.toString().startsWith(`${issuer}/authorize`)).toBe(true);
  });
});
