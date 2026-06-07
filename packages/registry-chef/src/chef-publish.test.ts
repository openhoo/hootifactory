import { describe, expect, test } from "bun:test";
import { multipartBoundary, parseChefPublishRequest, parseMultipartParts } from "./chef-publish";
import { buildMultipartBody } from "./chef-validation.test";

const enc = (s: string) => new TextEncoder().encode(s);

function multipartRequest(boundary: string, body: Uint8Array): Request {
  return new Request("https://registry.test/api/v1/cookbooks", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
}

describe("chef multipart parsing", () => {
  test("multipartBoundary reads quoted and unquoted boundary params", () => {
    expect(multipartBoundary('multipart/form-data; boundary="abc 123"')).toBe("abc 123");
    expect(multipartBoundary("multipart/form-data; boundary=plain")).toBe("plain");
    expect(multipartBoundary("application/json")).toBeNull();
  });

  test("parseMultipartParts extracts name + filename for each part", () => {
    const body = buildMultipartBody("BOUND", [
      { name: "cookbook", data: enc("{}") },
      { name: "tarball", filename: "nginx-1.0.0.tar.gz", data: new Uint8Array([1, 2, 3]) },
    ]);
    const parts = parseMultipartParts("BOUND", body);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ name: "cookbook", filename: null });
    expect(parts[1]).toMatchObject({ name: "tarball", filename: "nginx-1.0.0.tar.gz" });
    expect([...parts[1]!.data]).toEqual([1, 2, 3]);
  });

  test("parseMultipartParts returns no parts when the closing boundary is missing", () => {
    // A part header with no trailing `\r\n--BOUND` delimiter cannot be terminated.
    const body = enc(
      '--BOUND\r\nContent-Disposition: form-data; name="cookbook"\r\n\r\n{}\r\nno-close',
    );
    expect(parseMultipartParts("BOUND", body)).toEqual([]);
  });

  test("parseMultipartParts returns no parts when a header block has no CRLFCRLF", () => {
    const body = enc('--BOUND\r\nContent-Disposition: form-data; name="x"\r\nno-blank-line');
    expect(parseMultipartParts("BOUND", body)).toEqual([]);
  });

  test("publish parse rejects a body whose tarball part is empty", async () => {
    const body = buildMultipartBody("BOUND", [
      { name: "cookbook", data: enc(JSON.stringify({ name: "nginx", version: "1.0.0" })) },
      { name: "tarball", filename: "nginx-1.0.0.tar.gz", data: new Uint8Array(0) },
    ]);
    const result = await parseChefPublishRequest(multipartRequest("BOUND", body));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(400);
      expect(result.error.errorMessages[0]).toContain("empty");
    }
  });

  test("publish parse rejects a missing tarball part", async () => {
    const body = buildMultipartBody("BOUND", [
      { name: "cookbook", data: enc(JSON.stringify({ name: "nginx", version: "1.0.0" })) },
    ]);
    const result = await parseChefPublishRequest(multipartRequest("BOUND", body));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.errorMessages[0]).toContain("tarball");
  });

  test("publish parse rejects a cookbook part that is not valid JSON", async () => {
    const body = buildMultipartBody("BOUND", [
      { name: "cookbook", data: enc("{not json") },
      { name: "tarball", filename: "x.tar.gz", data: new Uint8Array([1]) },
    ]);
    const result = await parseChefPublishRequest(multipartRequest("BOUND", body));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.errorMessages[0]).toContain("JSON");
  });

  test("publish parse accepts a quoted boundary in the content-type", async () => {
    const body = buildMultipartBody("BO UND", [
      { name: "cookbook", data: enc(JSON.stringify({ name: "nginx", version: "1.0.0" })) },
      { name: "tarball", filename: "x.tar.gz", data: new Uint8Array([1, 2]) },
    ]);
    const req = new Request("https://registry.test/api/v1/cookbooks", {
      method: "POST",
      headers: { "content-type": 'multipart/form-data; boundary="BO UND"' },
      body,
    });
    const result = await parseChefPublishRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.metadata.name).toBe("nginx");
      expect([...result.plan.tarball]).toEqual([1, 2]);
    }
  });
});
