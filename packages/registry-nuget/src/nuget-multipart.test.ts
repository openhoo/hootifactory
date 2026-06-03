import { describe, expect, test } from "bun:test";
import { extractMultipartFile, multipartBoundary } from "./nuget-multipart";

const encoder = new TextEncoder();

describe("NuGet multipart helpers", () => {
  test("extracts the positional file part sent by dotnet nuget push", () => {
    const contentType = 'multipart/form-data; boundary="hoot-boundary"';
    const body = encoder.encode(
      [
        "--hoot-boundary",
        'Content-Disposition: form-data; name="package"; filename="Example.1.0.0.nupkg"',
        "Content-Type: application/octet-stream",
        "",
        "package-bytes",
        "--hoot-boundary--",
        "",
      ].join("\r\n"),
    );

    expect(
      new TextDecoder().decode(extractMultipartFile(contentType, body) ?? new Uint8Array()),
    ).toBe("package-bytes");
  });

  test("rejects malformed multipart content", () => {
    expect(multipartBoundary("multipart/form-data")).toBeNull();
    expect(extractMultipartFile("multipart/form-data", encoder.encode("not multipart"))).toBeNull();
  });
});
