import { describe, expect, test } from "bun:test";
import {
  buildGoPublishedMetadata,
  goUploadSuccessResponse,
  goVersionConflictResponse,
} from "./go-upload-lifecycle";

describe("Go upload lifecycle helpers", () => {
  test("stores the zip digest without dropping parsed upload metadata", () => {
    expect(
      buildGoPublishedMetadata(
        {
          metadata: {
            mod: "module example.com/hoot\n",
            zipSize: 42,
            time: "2026-01-02T03:04:05.000Z",
          },
        },
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ),
    ).toEqual({
      mod: "module example.com/hoot\n",
      zipSize: 42,
      time: "2026-01-02T03:04:05.000Z",
      zipDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
  });

  test("keeps Go upload response shapes", async () => {
    await expect(goUploadSuccessResponse("example.com/hoot", "v1.2.3").json()).resolves.toEqual({
      ok: true,
      module: "example.com/hoot",
      version: "v1.2.3",
    });
    expect(goVersionConflictResponse().status).toBe(409);
    await expect(goVersionConflictResponse().json()).resolves.toEqual({
      error: "version already exists",
    });
  });
});
