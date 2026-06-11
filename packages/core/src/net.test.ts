import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
  assertPublicHttpUrl,
  assertPublicResolvedUrl,
  inheritUrlCredentials,
  redactUrlCredentials,
  safeFetch,
} from "./net";

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

describe("assertPublicHttpUrl invalid URL", () => {
  test("wraps an unparseable URL in an invalid-URL error", () => {
    expect(() => assertPublicHttpUrl("http://")).toThrow("invalid URL");
    expect(() => assertPublicHttpUrl("not a url")).toThrow("invalid URL");
  });
});

describe("assertPublicResolvedUrl enforcement toggle", () => {
  test("short-circuits without resolving when enforcement is disabled", async () => {
    let resolved = false;
    await expect(
      assertPublicResolvedUrl(new URL("https://anything.test"), {
        enforce: false,
        lookupHost: async () => {
          resolved = true;
          return [{ address: "10.0.0.1" }];
        },
      }),
    ).resolves.toBeUndefined();
    expect(resolved).toBe(false);
  });

  test("rejects when DNS returns no addresses", async () => {
    await expect(
      assertPublicResolvedUrl(new URL("https://unresolvable.test"), {
        enforce: true,
        lookupHost: async () => [],
      }),
    ).rejects.toThrow("could not resolve upstream host");
  });

  test("rejects an IPv6-literal host that is private", async () => {
    await expect(
      assertPublicResolvedUrl(new URL("https://[::1]/"), { enforce: true }),
    ).rejects.toThrow("private/loopback/metadata");
  });
});

describe("safeFetch redirect budget and 3xx handling", () => {
  test("rejects after exhausting the redirect budget", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response(null, { status: 302, headers: { location: "/again" } });
      },
    });
    const host = `127.0.0.1:${server.port}`;
    try {
      await expect(
        safeFetch(`http://${host}/start`, {
          enforcePublicNetwork: false,
          allowedHosts: [host],
          maxHops: 1,
        }),
      ).rejects.toThrow("too many redirects");
    } finally {
      server.stop(true);
    }
  });

  test("returns a 3xx with no Location header instead of following", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response("see other", { status: 303 });
      },
    });
    const host = `127.0.0.1:${server.port}`;
    try {
      const res = await safeFetch(`http://${host}/x`, {
        enforcePublicNetwork: false,
        allowedHosts: [host],
      });
      expect(res.status).toBe(303);
    } finally {
      server.stop(true);
    }
  });
});

describe("redactUrlCredentials", () => {
  test("strips userinfo from a URL", () => {
    expect(redactUrlCredentials("https://user:p%40ss@host.test/a?b=c#d")).toBe(
      "https://host.test/a?b=c#d",
    );
    expect(redactUrlCredentials("https://user@host.test/a")).toBe("https://host.test/a");
  });

  test("returns a credential-free URL unchanged", () => {
    expect(redactUrlCredentials("https://host.test/a?b=c")).toBe("https://host.test/a?b=c");
  });

  test("textually strips userinfo from an unparseable URL", () => {
    expect(redactUrlCredentials("http://user:pass@")).toBe("http://");
  });
});

describe("inheritUrlCredentials", () => {
  test("copies credentials onto a same-host URL without its own userinfo", () => {
    expect(
      inheritUrlCredentials("https://host.test/pkg.tgz", "https://u:p%40w@host.test/npm"),
    ).toBe("https://u:p%40w@host.test/pkg.tgz");
  });

  test("never copies credentials onto another host", () => {
    expect(inheritUrlCredentials("https://other.test/pkg.tgz", "https://u:p@host.test/")).toBe(
      "https://other.test/pkg.tgz",
    );
  });

  test("keeps the target's own userinfo", () => {
    expect(inheritUrlCredentials("https://a:b@host.test/x", "https://u:p@host.test/")).toBe(
      "https://a:b@host.test/x",
    );
  });

  test("no-ops when the base has no credentials or a URL is unparseable", () => {
    expect(inheritUrlCredentials("https://host.test/x", "https://host.test/")).toBe(
      "https://host.test/x",
    );
    expect(inheritUrlCredentials("not a url", "https://u:p@host.test/")).toBe("not a url");
  });
});

describe("safeFetch credential forwarding (loopback test server)", () => {
  let server: ReturnType<typeof Bun.serve>;
  let other: ReturnType<typeof Bun.serve>;
  let host: string;
  let otherHost: string;
  const seen: { path: string; authorization: string | null }[] = [];

  beforeAll(() => {
    other = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        seen.push({ path: "other", authorization: req.headers.get("authorization") });
        return new Response("other ok");
      },
    });
    otherHost = `127.0.0.1:${other.port}`;
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const { pathname } = new URL(req.url);
        seen.push({ path: pathname, authorization: req.headers.get("authorization") });
        if (pathname === "/redirect-same-origin") {
          return new Response(null, { status: 302, headers: { location: "/final" } });
        }
        if (pathname === "/redirect-cross-origin") {
          return new Response(null, {
            status: 302,
            headers: { location: `http://${otherHost}/landed` },
          });
        }
        return new Response("ok");
      },
    });
    host = `127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
    other.stop(true);
  });

  test("lifts URL userinfo into a Basic Authorization header (percent-decoded)", async () => {
    seen.length = 0;
    const res = await safeFetch(`http://user:p%40ss@${host}/auth`, {
      enforcePublicNetwork: false,
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual([
      { path: "/auth", authorization: `Basic ${Buffer.from("user:p@ss").toString("base64")}` },
    ]);
  });

  test("keeps the credentials across a same-origin redirect", async () => {
    seen.length = 0;
    const res = await safeFetch(`http://user:pass@${host}/redirect-same-origin`, {
      enforcePublicNetwork: false,
    });
    expect(res.status).toBe(200);
    const auth = `Basic ${Buffer.from("user:pass").toString("base64")}`;
    expect(seen).toEqual([
      { path: "/redirect-same-origin", authorization: auth },
      { path: "/final", authorization: auth },
    ]);
  });

  test("never replays the credentials across a cross-origin redirect", async () => {
    seen.length = 0;
    const res = await safeFetch(`http://user:pass@${host}/redirect-cross-origin`, {
      enforcePublicNetwork: false,
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual([
      {
        path: "/redirect-cross-origin",
        authorization: `Basic ${Buffer.from("user:pass").toString("base64")}`,
      },
      { path: "other", authorization: null },
    ]);
  });

  test("sends no Authorization header when the URL carries no userinfo", async () => {
    seen.length = 0;
    await safeFetch(`http://${host}/plain`, { enforcePublicNetwork: false });
    expect(seen).toEqual([{ path: "/plain", authorization: null }]);
  });

  test("an explicit Authorization header wins over URL userinfo", async () => {
    seen.length = 0;
    await safeFetch(`http://user:pass@${host}/explicit`, {
      enforcePublicNetwork: false,
      headers: { authorization: "Bearer token-123" },
    });
    expect(seen).toEqual([{ path: "/explicit", authorization: "Bearer token-123" }]);
  });
});
