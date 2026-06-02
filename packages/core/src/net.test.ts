import { describe, expect, test } from "bun:test";
import { assertPublicResolvedUrl, isPrivateHost } from "./net";

describe("SSRF URL guards", () => {
  test("detects private and non-routable host literals", () => {
    expect(isPrivateHost("localhost")).toBe(true);
    expect(isPrivateHost("127.0.0.1")).toBe(true);
    expect(isPrivateHost("10.0.0.5")).toBe(true);
    expect(isPrivateHost("172.20.0.5")).toBe(true);
    expect(isPrivateHost("192.168.1.10")).toBe(true);
    expect(isPrivateHost("169.254.169.254")).toBe(true);
    expect(isPrivateHost("[::1]")).toBe(true);
    expect(isPrivateHost("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateHost("[::ffff:a9fe:a9fe]")).toBe(true);
    expect(isPrivateHost("64:ff9b::a9fe:a9fe")).toBe(true);
    expect(isPrivateHost("[64:ff9b::169.254.169.254]")).toBe(true);
    expect(isPrivateHost("64:ff9b:1:a9fe:a9:fe00::")).toBe(true);
    expect(isPrivateHost("::a9fe:a9fe")).toBe(true);
    expect(isPrivateHost("2002:a9fe:a9fe::")).toBe(true);
    expect(isPrivateHost("fe81::1")).toBe(true);
    expect(isPrivateHost("fec0::1")).toBe(true);
    expect(isPrivateHost("example.com")).toBe(false);
    expect(isPrivateHost("93.184.216.34")).toBe(false);
    expect(isPrivateHost("64:ff9b::0808:0808")).toBe(false);
    expect(isPrivateHost("64:ff9b:1:808:8:800::")).toBe(false);
    expect(isPrivateHost("::0808:0808")).toBe(false);
    expect(isPrivateHost("2002:0808:0808::")).toBe(false);
  });

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
