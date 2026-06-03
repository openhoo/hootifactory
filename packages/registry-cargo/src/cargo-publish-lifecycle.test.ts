import { describe, expect, test } from "bun:test";
import {
  buildCargoPublishedMetadata,
  cargoPublishSuccessResponse,
  cargoVersionAlreadyPublished,
} from "./cargo-publish-lifecycle";

describe("Cargo publish lifecycle helpers", () => {
  test("detects duplicate versions by Cargo identity", () => {
    const versions = [{ version: "1.2.3+first" }, { version: "2.0.0" }];

    expect(cargoVersionAlreadyPublished(versions, "1.2.3+second")).toBe(true);
    expect(cargoVersionAlreadyPublished(versions, "1.2.4")).toBe(false);
  });

  test("stores sparse index metadata with the blob digest", () => {
    const index = {
      name: "demo_crate",
      vers: "1.2.3",
      deps: [],
      cksum: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      features: {},
      yanked: false,
    };

    expect(
      buildCargoPublishedMetadata(
        index,
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ),
    ).toEqual({
      index,
      crateDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
  });

  test("keeps Cargo publish success response shape", async () => {
    await expect(cargoPublishSuccessResponse().json()).resolves.toEqual({
      warnings: { invalid_categories: [], invalid_badges: [], other: [] },
    });
  });
});
