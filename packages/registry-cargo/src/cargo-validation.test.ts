import { describe, expect, test } from "bun:test";
import { parseCargoVersionMeta } from "./cargo-validation";

const digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const checksum = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("Cargo validation helpers", () => {
  test("parses stored Cargo version metadata through a strict schema", () => {
    const parsed = parseCargoVersionMeta({
      index: {
        name: "demo_crate",
        vers: "1.2.3",
        deps: [
          {
            name: "dep",
            req: "^1",
            features: ["derive"],
            optional: false,
            default_features: true,
            target: null,
            kind: "normal",
            registry: null,
            package: null,
          },
        ],
        cksum: checksum,
        features: { default: ["dep/derive"] },
        yanked: false,
      },
      crateDigest: digest,
    });

    expect(parsed).toMatchObject({
      crateDigest: digest,
      index: { name: "demo_crate", vers: "1.2.3", cksum: checksum },
    });
  });

  test("rejects malformed stored Cargo metadata", () => {
    expect(
      parseCargoVersionMeta({
        index: {
          name: "demo_crate",
          vers: "1.2.3",
          deps: [],
          cksum: "not-a-checksum",
          features: {},
          yanked: false,
        },
        crateDigest: digest,
      }),
    ).toBeNull();

    expect(
      parseCargoVersionMeta({
        index: {
          name: "demo_crate",
          vers: "1.2.3",
          deps: [],
          cksum: checksum,
          features: {},
          yanked: false,
          extra: true,
        },
        crateDigest: digest,
      }),
    ).toBeNull();
  });
});
