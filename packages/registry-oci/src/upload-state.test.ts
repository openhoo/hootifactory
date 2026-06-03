import { describe, expect, test } from "bun:test";
import { uploadMultipartState } from "./upload-state";

describe("OCI upload state helpers", () => {
  test("treats missing or malformed multipart state as empty", () => {
    expect(uploadMultipartState(null)).toEqual({ chunks: [] });
    expect(uploadMultipartState("not json")).toEqual({ chunks: [] });
    expect(uploadMultipartState(JSON.stringify({ chunks: "bad" }))).toEqual({ chunks: [] });
  });

  test("keeps only well-formed staged chunks", () => {
    expect(
      uploadMultipartState(
        JSON.stringify({
          chunks: [
            { key: "upload/chunks/0", size: 0 },
            { key: "upload/chunks/1", size: 12 },
            { key: "", size: 1 },
            { key: "negative", size: -1 },
            { key: "float", size: 1.5 },
            null,
          ],
        }),
      ),
    ).toEqual({
      chunks: [
        { key: "upload/chunks/0", size: 0 },
        { key: "upload/chunks/1", size: 12 },
      ],
    });
  });
});
