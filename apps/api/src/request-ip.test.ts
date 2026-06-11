import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  clientIp,
  clientIpOrUndefined,
  compileTrustedProxies,
  resolveClientIp,
  type TrustedProxyRange,
  UNKNOWN_CLIENT_IP,
} from "./request-ip";
import type { AppEnv } from "./types";

function trusted(...entries: string[]): TrustedProxyRange[] {
  return compileTrustedProxies(entries);
}

function resolve(
  peerAddress: string | null,
  forwardedFor: string | null,
  trustedProxies: readonly TrustedProxyRange[] = [],
): string {
  return resolveClientIp({ peerAddress, forwardedFor, trustedProxies });
}

describe("resolveClientIp", () => {
  test("returns the direct peer when no proxies are configured", () => {
    expect(resolve("203.0.113.5", null)).toBe("203.0.113.5");
    expect(resolve("203.0.113.5", "198.51.100.1")).toBe("203.0.113.5");
  });

  test("never trusts x-forwarded-for from an untrusted peer", () => {
    expect(resolve("203.0.113.5", "198.51.100.1", trusted("10.0.0.0/8"))).toBe("203.0.113.5");
  });

  test("walks x-forwarded-for from the rightmost untrusted hop behind a trusted proxy", () => {
    expect(resolve("10.0.0.2", "198.51.100.7", trusted("10.0.0.0/8"))).toBe("198.51.100.7");
    expect(resolve("10.0.0.2", "198.51.100.7, 10.0.0.3", trusted("10.0.0.0/8"))).toBe(
      "198.51.100.7",
    );
  });

  test("stops at the first untrusted hop so client-prepended addresses are ignored", () => {
    expect(resolve("10.0.0.2", "1.2.3.4, 198.51.100.7", trusted("10.0.0.0/8"))).toBe(
      "198.51.100.7",
    );
  });

  test("falls back to the proxy peer when every hop is trusted or the header is absent", () => {
    expect(resolve("10.0.0.2", null, trusted("10.0.0.0/8"))).toBe("10.0.0.2");
    expect(resolve("10.0.0.2", "  ", trusted("10.0.0.0/8"))).toBe("10.0.0.2");
    expect(resolve("10.0.0.2", "10.0.0.9, 10.0.0.3", trusted("10.0.0.0/8"))).toBe("10.0.0.2");
  });

  test("rejects garbage instead of misattributing a forwarded address", () => {
    expect(resolve("10.0.0.2", "not-an-ip", trusted("10.0.0.0/8"))).toBe(UNKNOWN_CLIENT_IP);
    expect(resolve("10.0.0.2", "198.51.100.7, garbage", trusted("10.0.0.0/8"))).toBe(
      UNKNOWN_CLIENT_IP,
    );
    expect(resolve("10.0.0.2", "198.51.100.7,", trusted("10.0.0.0/8"))).toBe(UNKNOWN_CLIENT_IP);
    expect(resolve("10.0.0.2", "999.0.0.1", trusted("10.0.0.0/8"))).toBe(UNKNOWN_CLIENT_IP);
  });

  test("returns unknown when no peer information is available", () => {
    expect(resolve(null, "198.51.100.1", trusted("10.0.0.0/8"))).toBe(UNKNOWN_CLIENT_IP);
    expect(resolve("", null)).toBe(UNKNOWN_CLIENT_IP);
    expect(resolve("bogus", null)).toBe(UNKNOWN_CLIENT_IP);
  });

  test("matches exact-IP trusted entries only", () => {
    const proxies = trusted("203.0.113.10");
    expect(resolve("203.0.113.10", "198.51.100.7", proxies)).toBe("198.51.100.7");
    expect(resolve("203.0.113.11", "198.51.100.7", proxies)).toBe("203.0.113.11");
  });

  test("supports IPv6 peers, CIDR ranges, and canonical formatting", () => {
    const proxies = trusted("2001:db8::/32");
    expect(resolve("2001:DB8::1", "2406:da00:0:0::1", proxies)).toBe("2406:da00::1");
    expect(resolve("2001:db8:ffff::2", null, proxies)).toBe("2001:db8:ffff::2");
    expect(resolve("2001:DB8:0:0:0:0:0:1", null, [])).toBe("2001:db8::1");
  });

  test("normalizes IPv4-mapped IPv6 addresses to IPv4", () => {
    expect(resolve("::ffff:192.0.2.7", null)).toBe("192.0.2.7");
    // A v4-mapped peer still matches a plain IPv4 trusted entry.
    expect(resolve("::ffff:10.0.0.2", "198.51.100.7", trusted("10.0.0.0/8"))).toBe("198.51.100.7");
  });

  test("strips ports, brackets, and zone identifiers from candidates", () => {
    expect(resolve("10.0.0.2", "[2001:db8::1]:443", trusted("10.0.0.0/8"))).toBe("2001:db8::1");
    expect(resolve("10.0.0.2", "198.51.100.7:6534", trusted("10.0.0.0/8"))).toBe("198.51.100.7");
    expect(resolve("fe80::1%eth0", null)).toBe("fe80::1");
  });
});

describe("compileTrustedProxies", () => {
  test("skips entries that do not parse", () => {
    expect(compileTrustedProxies(["nope", "10.0.0.0/33", "10.0.0.0/8"])).toHaveLength(1);
  });
});

describe("clientIp", () => {
  function appReturningIp(trustedProxies?: TrustedProxyRange[]) {
    const app = new Hono<AppEnv>();
    app.get("/", (c) => c.text(trustedProxies ? clientIp(c, trustedProxies) : clientIp(c)));
    return app;
  }

  function bunServer(address: string) {
    return { requestIP: () => ({ address, family: "IPv4", port: 4711 }) };
  }

  test("reads the socket peer from the Bun server binding", async () => {
    const response = await appReturningIp().fetch(
      new Request("http://localhost/"),
      bunServer("203.0.113.9"),
    );
    expect(await response.text()).toBe("203.0.113.9");
  });

  test("supports a binding that nests the server", async () => {
    const response = await appReturningIp().fetch(new Request("http://localhost/"), {
      server: bunServer("203.0.113.9"),
    });
    expect(await response.text()).toBe("203.0.113.9");
  });

  test("does not trust client-supplied forwarding headers by default", async () => {
    const response = await appReturningIp().fetch(
      new Request("http://localhost/", {
        headers: {
          "x-forwarded-for": "198.51.100.10",
          "x-real-ip": "198.51.100.11",
        },
      }),
      bunServer("203.0.113.9"),
    );
    expect(await response.text()).toBe("203.0.113.9");
  });

  test("walks x-forwarded-for when the peer is a trusted proxy", async () => {
    const response = await appReturningIp(compileTrustedProxies(["10.0.0.0/8"])).fetch(
      new Request("http://localhost/", {
        headers: { "x-forwarded-for": "198.51.100.10, 10.0.0.4" },
      }),
      bunServer("10.0.0.2"),
    );
    expect(await response.text()).toBe("198.51.100.10");
  });

  test("returns unknown when no server transport is available", async () => {
    const app = appReturningIp();
    const response = await app.request("/", {
      headers: { "x-forwarded-for": "198.51.100.10" },
    });
    expect(await response.text()).toBe(UNKNOWN_CLIENT_IP);
  });

  test("clientIpOrUndefined maps unknown to undefined for optional columns", async () => {
    const app = new Hono<AppEnv>();
    app.get("/", (c) => c.json({ ip: clientIpOrUndefined(c) ?? null }));
    const withoutServer = await app.request("/");
    expect(await withoutServer.json()).toEqual({ ip: null });
    const withServer = await app.fetch(new Request("http://localhost/"), bunServer("203.0.113.9"));
    expect(await withServer.json()).toEqual({ ip: "203.0.113.9" });
  });
});
