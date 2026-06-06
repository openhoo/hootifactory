import { describe, expect, test } from "bun:test";
import type { RouteEntry } from "../plugin/adapter";
import { compileRoutes, matchRoute } from "./route-matcher";

const dockerRoutes: RouteEntry[] = [
  { method: "GET", pattern: "/:name+/tags/list", handlerId: "tagsList" },
  { method: "PUT", pattern: "/:name+/manifests/:reference", handlerId: "putManifest" },
  { method: "GET", pattern: "/:name+/manifests/:reference", handlerId: "getManifest" },
  { method: "HEAD", pattern: "/:name+/manifests/:reference", handlerId: "headManifest" },
  { method: "POST", pattern: "/:name+/blobs/uploads", handlerId: "startUpload" },
  { method: "PATCH", pattern: "/:name+/blobs/uploads/:uuid", handlerId: "patchUpload" },
  { method: "PUT", pattern: "/:name+/blobs/uploads/:uuid", handlerId: "putUpload" },
  { method: "GET", pattern: "/:name+/blobs/:digest", handlerId: "getBlob" },
];
const compiled = compileRoutes(dockerRoutes);

describe("route matcher — greedy :name+", () => {
  test("multi-segment image name + manifest reference", () => {
    const m = matchRoute(compiled, "GET", "/library/ubuntu/manifests/latest");
    expect(m?.entry.handlerId).toBe("getManifest");
    expect(m?.params.name).toBe("library/ubuntu");
    expect(m?.params.reference).toBe("latest");
  });

  test("single-segment name + blob digest", () => {
    const m = matchRoute(compiled, "GET", "/myimg/blobs/sha256:abcdef");
    expect(m?.entry.handlerId).toBe("getBlob");
    expect(m?.params.name).toBe("myimg");
    expect(m?.params.digest).toBe("sha256:abcdef");
  });

  test("deep image name + start upload", () => {
    const m = matchRoute(compiled, "POST", "/a/b/c/blobs/uploads");
    expect(m?.entry.handlerId).toBe("startUpload");
    expect(m?.params.name).toBe("a/b/c");
  });

  test("upload chunk with uuid", () => {
    const m = matchRoute(compiled, "PATCH", "/x/blobs/uploads/upload-uuid-123");
    expect(m?.entry.handlerId).toBe("patchUpload");
    expect(m?.params.name).toBe("x");
    expect(m?.params.uuid).toBe("upload-uuid-123");
  });

  test("blob-get pattern does not swallow an uploads path", () => {
    // "/x/blobs/uploads/u" has two segments after /blobs/, so :digest ([^/]+) can't match
    expect(matchRoute(compiled, "GET", "/x/blobs/uploads/u")).toBeNull();
  });

  test("tags list", () => {
    const m = matchRoute(compiled, "GET", "/team/svc/api/tags/list");
    expect(m?.entry.handlerId).toBe("tagsList");
    expect(m?.params.name).toBe("team/svc/api");
  });

  test("method mismatch yields null", () => {
    expect(matchRoute(compiled, "DELETE", "/x/tags/list")).toBeNull();
  });

  test("url-encoded segment is decoded", () => {
    const m = matchRoute(compiled, "GET", "/%40scope%2Fpkg/manifests/1.0.0");
    expect(m?.params.name).toBe("@scope/pkg");
  });
});

describe("route matcher — encoded path separators in single-segment :param", () => {
  test("rejects %2F-encoded slash in a single-segment :reference", () => {
    // `[^/]+` matches `v1%2F..%2Fevil` as one segment against the encoded path;
    // decoding must not produce an embedded-slash param. The match fails instead.
    expect(matchRoute(compiled, "GET", "/lib/manifests/v1%2F..%2Fevil")).toBeNull();
    expect(matchRoute(compiled, "GET", "/lib/manifests/v1%2f..%2fevil")).toBeNull();
  });

  test("rejects traversal-only %2F payload in a single-segment :reference", () => {
    expect(matchRoute(compiled, "GET", "/lib/manifests/..%2F..%2Fother")).toBeNull();
  });

  test("rejects %2F in a single-segment :digest", () => {
    expect(matchRoute(compiled, "GET", "/lib/blobs/sha256%2F..%2Fevil")).toBeNull();
  });

  test("legitimate single-segment value still matches", () => {
    const m = matchRoute(compiled, "GET", "/lib/manifests/v1.0.0");
    expect(m?.entry.handlerId).toBe("getManifest");
    expect(m?.params.reference).toBe("v1.0.0");
  });

  test("single-segment value with a non-separator encoded char still decodes", () => {
    // `%2B` -> "+" stays within one segment, so the match is honoured.
    const m = matchRoute(compiled, "GET", "/lib/manifests/v1%2B1");
    expect(m?.params.reference).toBe("v1+1");
  });

  test("greedy :name+ still spans encoded slashes", () => {
    const m = matchRoute(compiled, "GET", "/%40scope%2Fpkg/manifests/latest");
    expect(m?.entry.handlerId).toBe("getManifest");
    expect(m?.params.name).toBe("@scope/pkg");
    expect(m?.params.reference).toBe("latest");
  });
});
