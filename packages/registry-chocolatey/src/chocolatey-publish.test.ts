import { describe, expect, test } from "bun:test";
import { chocolateyBlobScope, parseChocolateyPublishRequest } from "./chocolatey-publish";
import { buildChocolateyPublishedMetadata } from "./chocolatey-publish-lifecycle";
import { makeStoredZip } from "./testing/zip-fixture";

const digest = `sha256:${"a".repeat(64)}`;

function nupkg(id: string, version: string): Uint8Array {
  return makeStoredZip(
    `${id}.nuspec`,
    `<package><metadata><id>${id}</id><version>${version}</version>` +
      `<title>${id}</title><authors>Author</authors>` +
      `<dependencies><dependency id="chocolatey" version="[0.10.3,)" /></dependencies>` +
      `</metadata></package>`,
  );
}

describe("Chocolatey publish helpers", () => {
  test("blob scope is the lowercased {id}.{version}.nupkg filename", () => {
    expect(chocolateyBlobScope("git", "2.43.0")).toBe("git.2.43.0.nupkg");
  });

  test("merges the stored digest and size into the published metadata", () => {
    expect(
      buildChocolateyPublishedMetadata(
        {
          metadata: {
            id: "git",
            version: "2.43.0",
            packageHash: "hash==",
            packageHashAlgorithm: "SHA512",
            listed: true,
          },
        },
        digest,
        2048,
      ),
    ).toEqual({
      id: "git",
      version: "2.43.0",
      packageHash: "hash==",
      packageHashAlgorithm: "SHA512",
      listed: true,
      nupkgDigest: digest,
      size: 2048,
    });
  });
});

describe("Chocolatey publish request parsing", () => {
  test("derives id, normalized version, hash, and metadata from a raw nupkg body", async () => {
    const bytes = nupkg("Git", "2.43");
    const req = new Request("https://registry.test/chocolatey/private/api/v2/package", {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
    });

    const result = await parseChocolateyPublishRequest(req);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.plan.id).toBe("Git");
    expect(result.plan.lowerId).toBe("git");
    expect(result.plan.version).toBe("2.43.0");
    expect(result.plan.scope).toBe("git.2.43.0.nupkg");
    expect(result.plan.packageHashAlgorithm).toBe("SHA512");
    expect(result.plan.packageHash.length).toBeGreaterThan(0);
    expect(result.plan.metadata.title).toBe("Git");
    expect(result.plan.metadata.dependencies).toEqual([{ id: "chocolatey", range: "[0.10.3,)" }]);
  });

  test("extracts the nupkg from a multipart push body", async () => {
    const bytes = nupkg("Git", "1.0.0");
    const boundary = "----choco";
    const head = new TextEncoder().encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="package"; filename="git.nupkg"\r\n\r\n`,
    );
    const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
    const body = new Uint8Array([...head, ...bytes, ...tail]);
    const req = new Request("https://registry.test/chocolatey/private/api/v2/package", {
      method: "PUT",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body,
    });

    const result = await parseChocolateyPublishRequest(req);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.plan.lowerId).toBe("git");
    expect(result.plan.version).toBe("1.0.0");
  });

  test("rejects a nuspec whose dependency range carries reserved OData delimiters", async () => {
    // `:`/`|` in a range would forge extra `id:range:tfm` entries in the feed's
    // `<d:Dependencies>` string; reject at publish so it is never persisted.
    const bytes = makeStoredZip(
      "evil.nuspec",
      `<package><metadata><id>evil</id><version>1.0.0</version>` +
        `<title>evil</title><authors>Author</authors>` +
        `<dependencies><dependency id="chocolatey" version="[1.0,):|forged:[9.9,)" /></dependencies>` +
        `</metadata></package>`,
    );
    const req = new Request("https://registry.test/chocolatey/private/api/v2/package", {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
    });
    const result = await parseChocolateyPublishRequest(req);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.status).toBe(400);
  });

  test("rejects a body without a parseable nuspec", async () => {
    const req = new Request("https://registry.test/chocolatey/private/api/v2/package", {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array([1, 2, 3]),
    });
    const result = await parseChocolateyPublishRequest(req);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.status).toBe(400);
  });
});
