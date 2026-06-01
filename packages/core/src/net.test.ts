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
    expect(isPrivateHost("example.com")).toBe(false);
    expect(isPrivateHost("93.184.216.34")).toBe(false);
  });

  test("rejects public hostnames that resolve to private addresses in enforced mode", async () => {
    await expect(
      assertPublicResolvedUrl(new URL("https://registry.example.test"), {
        enforce: true,
        lookupHost: async () => [{ address: "10.0.0.8" }],
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
