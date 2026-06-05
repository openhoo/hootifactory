import { describe, expect, test } from "bun:test";

describe("production seed output", () => {
  test("does not expose a production token-print escape hatch", async () => {
    const seed = await Bun.file(new URL("../../../scripts/seed.ts", import.meta.url)).text();
    const envExample = await Bun.file(new URL("../../../.env.example", import.meta.url)).text();
    const readme = await Bun.file(new URL("../../../README.md", import.meta.url)).text();

    expect(seed).not.toContain("SEED_PRINT_TOKEN");
    expect(envExample).not.toContain("SEED_PRINT_TOKEN");
    expect(readme).not.toContain("SEED_PRINT_TOKEN");
    expect(seed).toContain("password set from SEED_PASS");
    expect(seed).toContain("not minted in production");
  });
});
