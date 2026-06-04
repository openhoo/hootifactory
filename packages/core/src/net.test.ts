import { describe, expect, test } from "bun:test";
import { assertPublicResolvedUrl } from "./net";

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
