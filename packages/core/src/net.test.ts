import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { assertPublicHttpUrl, assertPublicResolvedUrl, safeFetch } from "./net";

describe("SSRF URL guards", () => {
  test("rejects public hostnames that resolve to private addresses in enforced mode", async () => {
    await expect(
      assertPublicResolvedUrl(new URL("https://registry.example.test"), {
        enforce: true,
        lookupHost: async () => [{ address: "10.0.0.8" }],
      }),
    ).rejects.toThrow("DNS resolved to private");
  });

  test("rejects public hostnames that resolve to IPv6 literals with private embedded IPv4", async () => {
    await expect(
      assertPublicResolvedUrl(new URL("https://registry.example.test"), {
        enforce: true,
        lookupHost: async () => [{ address: "64:ff9b::a9fe:a9fe" }],
      }),
    ).rejects.toThrow("DNS resolved to private");
  });

  test("allows public hostnames when all resolved addresses are public", async () => {
    await expect(
      assertPublicResolvedUrl(new URL("https://registry.example.test"), {
        enforce: true,
        lookupHost: async () => [{ address: "93.184.216.34" }],
      }),
    ).resolves.toBeUndefined();
  });
});

describe("assertPublicHttpUrl", () => {
  test("rejects non-http(s) schemes", () => {
    expect(() => assertPublicHttpUrl("file:///etc/passwd")).toThrow("unsupported URL scheme");
    expect(() => assertPublicHttpUrl("gopher://example.test/")).toThrow("unsupported URL scheme");
  });

  test("rejects private, loopback, and cloud-metadata literal hosts in enforced mode", () => {
    expect(() => assertPublicHttpUrl("http://127.0.0.1/")).toThrow("private/loopback/metadata");
    expect(() => assertPublicHttpUrl("http://169.254.169.254/latest/meta-data/")).toThrow(
      "private/loopback/metadata",
    );
    expect(() => assertPublicHttpUrl("http://[::1]/")).toThrow("private/loopback/metadata");
  });

  test("returns the URL for a public https host", () => {
    const url = assertPublicHttpUrl("https://registry.example.test/path");
    expect(url.hostname).toBe("registry.example.test");
  });

  test("the private-host block is gated by enforcePublicNetwork", () => {
    expect(() =>
      assertPublicHttpUrl("http://127.0.0.1/", { enforcePublicNetwork: false }),
    ).not.toThrow();
  });
});

describe("safeFetch SSRF guards (pre-request, hermetic)", () => {
  test("rejects non-http(s) schemes before any network call", async () => {
    await expect(safeFetch("file:///etc/passwd")).rejects.toThrow("unsupported URL scheme");
  });

  test("rejects private/metadata literal hosts before any network call", async () => {
    await expect(safeFetch("http://127.0.0.1/")).rejects.toThrow("private/loopback/metadata");
    await expect(safeFetch("http://169.254.169.254/latest/")).rejects.toThrow(
      "private/loopback/metadata",
    );
  });

  test("rejects an initial host outside the allowlist before any network call", async () => {
    await expect(safeFetch("https://evil.test/x", { allowedHosts: ["good.test"] })).rejects.toThrow(
      "redirected to disallowed host",
    );
  });
});

describe("safeFetch redirect re-validation (loopback test server)", () => {
  // enforcePublicNetwork:false so the loopback test server itself is reachable;
  // this exercises that redirects are FOLLOWED and each hop is re-validated.
  let server: ReturnType<typeof Bun.serve>;
  let host: string;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const { pathname } = new URL(req.url);
        if (pathname === "/redirect-external") {
          return new Response(null, { status: 302, headers: { location: "http://evil.test/" } });
        }
        if (pathname === "/redirect-local") {
          return new Response(null, { status: 302, headers: { location: "/final" } });
        }
        return new Response("ok");
      },
    });
    host = `127.0.0.1:${server.port}`;
  });

  afterAll(() => server.stop(true));

  test("follows a redirect and re-validates the new host against the allowlist", async () => {
    await expect(
      safeFetch(`http://${host}/redirect-external`, {
        enforcePublicNetwork: false,
        allowedHosts: [host],
      }),
    ).rejects.toThrow("redirected to disallowed host: evil.test");
  });

  test("follows a same-host redirect through to the final 200", async () => {
    const res = await safeFetch(`http://${host}/redirect-local`, {
      enforcePublicNetwork: false,
      allowedHosts: [host],
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});
