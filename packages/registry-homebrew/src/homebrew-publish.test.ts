import { describe, expect, test } from "bun:test";
import { parseHomebrewPublishRequest } from "./homebrew-publish";

function multipart(parts: { bottle?: boolean; formula?: string }): Request {
  const form = new FormData();
  if (parts.bottle ?? true) {
    form.set("bottle", new File([new TextEncoder().encode("gzip")], "bottle.tar.gz"));
  }
  if (parts.formula !== undefined) form.set("formula", parts.formula);
  return new Request("https://registry.test/api/formula/hootcli/1.2.3/arm64_sonoma", {
    method: "PUT",
    body: form,
  });
}

describe("parseHomebrewPublishRequest", () => {
  test("parses a bottle part plus optional formula metadata", async () => {
    const result = await parseHomebrewPublishRequest(
      "hootcli",
      "1.2.3",
      "arm64_sonoma",
      multipart({ formula: JSON.stringify({ desc: "demo", license: "MIT" }) }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.plan.name).toBe("hootcli");
    expect(result.plan.version).toBe("1.2.3");
    expect(result.plan.tag).toBe("arm64_sonoma");
    expect(result.plan.info).toEqual({ desc: "demo", license: "MIT" });
    expect(result.plan.bottle).toBeInstanceOf(File);
  });

  test("defaults formula metadata to an empty object when omitted", async () => {
    const result = await parseHomebrewPublishRequest(
      "hootcli",
      "1.2.3",
      "arm64_sonoma",
      multipart({}),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.plan.info).toEqual({});
  });

  test("fails when the bottle part is missing", async () => {
    const result = await parseHomebrewPublishRequest(
      "hootcli",
      "1.2.3",
      "arm64_sonoma",
      multipart({ bottle: false }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.status).toBe(400);
  });

  test("fails on a non-multipart body", async () => {
    const result = await parseHomebrewPublishRequest(
      "hootcli",
      "1.2.3",
      "arm64_sonoma",
      new Request("https://registry.test/api/formula/hootcli/1.2.3/arm64_sonoma", {
        method: "PUT",
        body: "raw",
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    expect(result.ok).toBe(false);
  });

  test("rejects invalid names, versions, and tags before reading the body", async () => {
    await expect(
      parseHomebrewPublishRequest("Bad/Name", "1.2.3", "arm64_sonoma", multipart({})),
    ).rejects.toThrow();
    await expect(
      parseHomebrewPublishRequest("hootcli", "bad version", "arm64_sonoma", multipart({})),
    ).rejects.toThrow();
    await expect(
      parseHomebrewPublishRequest("hootcli", "1.2.3", "Bad-Tag", multipart({})),
    ).rejects.toThrow();
  });

  test("rejects a malformed formula JSON part", async () => {
    const result = await parseHomebrewPublishRequest(
      "hootcli",
      "1.2.3",
      "arm64_sonoma",
      multipart({ formula: "{not json" }),
    );
    expect(result.ok).toBe(false);
  });
});
