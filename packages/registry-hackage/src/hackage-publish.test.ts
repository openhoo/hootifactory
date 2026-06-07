import { describe, expect, test } from "bun:test";
import { parseHackagePublishRequest } from "./hackage-publish";
import { buildSdistTarGz } from "./hackage-tarball.test";

const CABAL = "name: demo\nversion: 1.2.3\nsynopsis: demo lib\nbuild-depends: base\n";

function multipartRequest(sdist: Uint8Array, field = "package"): Request {
  const form = new FormData();
  form.set(field, new File([sdist], "demo-1.2.3.tar.gz", { type: "application/gzip" }));
  return new Request("https://registry.test/packages/", { method: "POST", body: form });
}

describe("parseHackagePublishRequest", () => {
  test("extracts name/version/cabal from a multipart 'package' field", async () => {
    const sdist = buildSdistTarGz([{ path: "demo-1.2.3/demo.cabal", content: CABAL }]);
    const result = await parseHackagePublishRequest(null, multipartRequest(sdist));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.plan.name).toBe("demo");
    expect(result.plan.version).toBe("1.2.3");
    expect(result.plan.cabal).toBe(CABAL);
    expect(result.plan.fields.buildDepends).toEqual(["base"]);
    expect(result.plan.sdist).toEqual(sdist);
  });

  test("accepts a raw .tar.gz body when an id is supplied and matches", async () => {
    const sdist = buildSdistTarGz([{ path: "demo-1.2.3/demo.cabal", content: CABAL }]);
    const req = new Request("https://registry.test/package/demo-1.2.3", {
      method: "PUT",
      headers: { "content-type": "application/gzip" },
      body: sdist,
    });
    const result = await parseHackagePublishRequest({ name: "demo", version: "1.2.3" }, req);
    expect(result.ok).toBe(true);
  });

  test("rejects when the multipart 'package' field is absent", async () => {
    const sdist = buildSdistTarGz([{ path: "demo-1.2.3/demo.cabal", content: CABAL }]);
    const result = await parseHackagePublishRequest(null, multipartRequest(sdist, "wrong"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.status).toBe(400);
    expect(result.error.error).toBe("missing 'package' file field");
  });

  test("rejects an empty body with 400", async () => {
    const req = new Request("https://registry.test/packages/", {
      method: "POST",
      headers: { "content-type": "application/gzip" },
      body: new Uint8Array(0),
    });
    const result = await parseHackagePublishRequest(null, req);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.status).toBe(400);
    expect(result.error.error).toBe("package archive is empty");
  });

  test("rejects a body that is not a valid .tar.gz sdist with 400", async () => {
    const req = new Request("https://registry.test/packages/", {
      method: "POST",
      headers: { "content-type": "application/gzip" },
      body: new Uint8Array([1, 2, 3, 4, 5]),
    });
    const result = await parseHackagePublishRequest(null, req);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.status).toBe(400);
  });

  test("rejects a tar.gz whose only .cabal is nested below the root (no top-level cabal)", async () => {
    const sdist = buildSdistTarGz([
      { path: "demo-1.2.3/vendor/dep.cabal", content: "name: dep\nversion: 9.9\n" },
    ]);
    const result = await parseHackagePublishRequest(null, multipartRequest(sdist));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.status).toBe(400);
  });

  test("rejects when the .cabal id does not match the supplied url id", async () => {
    const sdist = buildSdistTarGz([
      { path: "demo-1.2.3/demo.cabal", content: "name: demo\nversion: 9.9.9\n" },
    ]);
    const result = await parseHackagePublishRequest(
      { name: "demo", version: "1.2.3" },
      multipartRequest(sdist),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.status).toBe(400);
  });
});
