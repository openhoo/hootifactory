import { describe, expect, test } from "bun:test";
import { buildPackument } from "./packument";

describe("npm packument builder", () => {
  test("builds versions, dist-tags, and package times from stored rows", () => {
    const packument = buildPackument(
      "@scope/pkg",
      [
        {
          version: "1.0.0",
          metadata: { manifest: { name: "@scope/pkg", version: "1.0.0" } },
          createdAt: new Date("2024-01-01T00:00:00Z"),
        },
        {
          version: "1.1.0",
          metadata: {
            manifest: {
              name: "@scope/pkg",
              version: "1.1.0",
              description: "latest description",
              readme: "# Readme",
            },
          },
          createdAt: new Date("2024-02-01T00:00:00Z"),
        },
      ],
      { latest: "1.1.0", beta: "1.0.0" },
    );

    expect(packument).toMatchObject({
      _id: "@scope/pkg",
      name: "@scope/pkg",
      "dist-tags": { latest: "1.1.0", beta: "1.0.0" },
      description: "latest description",
      readme: "# Readme",
      time: {
        created: "2024-01-01T00:00:00.000Z",
        modified: "2024-02-01T00:00:00.000Z",
        "1.0.0": "2024-01-01T00:00:00.000Z",
        "1.1.0": "2024-02-01T00:00:00.000Z",
      },
    });
    expect((packument.versions as Record<string, unknown>)["1.1.0"]).toMatchObject({
      version: "1.1.0",
    });
  });

  test("falls back to minimal manifests when metadata is missing", () => {
    const packument = buildPackument(
      "pkg",
      [{ version: "0.1.0", metadata: {}, createdAt: new Date("2024-01-01T00:00:00Z") }],
      {},
    );

    expect((packument.versions as Record<string, unknown>)["0.1.0"]).toEqual({
      name: "pkg",
      version: "0.1.0",
    });
  });
});
