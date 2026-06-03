import { describe, expect, test } from "bun:test";
import { buildCargoIndexEntry, parseCargoPublishBody } from "./cargo-publish";

const encoder = new TextEncoder();

function cargoPublishBody(metadata: object, crateBytes: Uint8Array): Uint8Array {
  const json = encoder.encode(JSON.stringify(metadata));
  const body = new Uint8Array(4 + json.length + 4 + crateBytes.length);
  const dv = new DataView(body.buffer);
  dv.setUint32(0, json.length, true);
  body.set(json, 4);
  dv.setUint32(4 + json.length, crateBytes.length, true);
  body.set(crateBytes, 4 + json.length + 4);
  return body;
}

describe("Cargo publish helpers", () => {
  test("parses Cargo publish framing and validates metadata", () => {
    const crateBytes = encoder.encode("crate bytes");
    const parsed = parseCargoPublishBody(
      cargoPublishBody(
        {
          name: "demo_crate",
          vers: "1.2.3",
          deps: [],
          features: {},
          links: null,
          rust_version: null,
        },
        crateBytes,
      ),
    );

    expect(parsed.metadata).toMatchObject({ name: "demo_crate", vers: "1.2.3" });
    expect(parsed.crateBytes).toEqual(crateBytes);
  });

  test("rejects truncated publish bodies before reading beyond bounds", () => {
    expect(() => parseCargoPublishBody(new Uint8Array([1, 2, 3]))).toThrow();
    expect(() =>
      parseCargoPublishBody(cargoPublishBody({ name: "demo_crate" }, encoder.encode("crate"))),
    ).toThrow();
  });

  test("builds sparse-index metadata with Cargo renamed dependency semantics", () => {
    const entry = buildCargoIndexEntry(
      {
        name: "demo_crate",
        vers: "1.2.3",
        deps: [
          {
            name: "real_dep",
            version_req: "^2.0",
            explicit_name_in_toml: "alias_dep",
            features: ["derive"],
            optional: true,
            default_features: false,
            target: "cfg(unix)",
            kind: "dev",
            registry: "https://example.test/index",
          },
        ],
        features: { default: ["alias_dep"] },
        links: "native",
        rust_version: "1.85",
      },
      "abc123",
    );

    expect(entry).toMatchObject({
      name: "demo_crate",
      vers: "1.2.3",
      cksum: "abc123",
      features: { default: ["alias_dep"] },
      yanked: false,
      links: "native",
      rust_version: "1.85",
    });
    expect(entry.deps).toEqual([
      {
        name: "alias_dep",
        req: "^2.0",
        features: ["derive"],
        optional: true,
        default_features: false,
        target: "cfg(unix)",
        kind: "dev",
        registry: "https://example.test/index",
        package: "real_dep",
      },
    ]);
  });
});
