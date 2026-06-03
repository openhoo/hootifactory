import { Errors, parseRegistryInput } from "@hootifactory/registry";
import {
  type CargoIndexEntry,
  type CargoPublishMetadata,
  CargoPublishMetadataSchema,
} from "./cargo-validation";

const textDecoder = new TextDecoder();

export interface CargoPublishBody {
  metadata: CargoPublishMetadata;
  crateBytes: Uint8Array;
}

export function parseCargoPublishBody(buf: Uint8Array): CargoPublishBody {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // Length-prefixed framing: u32 jsonLen | json | u32 crateLen | crate.
  if (buf.byteLength < 4) throw Errors.manifestInvalid({ reason: "truncated publish header" });

  let off = 0;
  const jsonLen = dv.getUint32(off, true);
  off += 4;
  if (off + jsonLen + 4 > buf.byteLength) {
    throw Errors.manifestInvalid({ reason: "truncated publish metadata" });
  }

  let rawMetadata: unknown;
  try {
    rawMetadata = JSON.parse(textDecoder.decode(buf.subarray(off, off + jsonLen)));
  } catch {
    throw Errors.manifestInvalid({ reason: "invalid publish metadata json" });
  }
  off += jsonLen;

  const crateLen = dv.getUint32(off, true);
  off += 4;
  if (off + crateLen !== buf.byteLength) {
    throw Errors.manifestInvalid({ reason: "crate length does not match body" });
  }

  return {
    metadata: parseRegistryInput(CargoPublishMetadataSchema, rawMetadata, {
      code: "MANIFEST_INVALID",
      message: "invalid publish metadata",
    }),
    crateBytes: buf.subarray(off, off + crateLen),
  };
}

export function cargoBlobScope(name: string, version: string): string {
  return `${name}@${version}.crate`;
}

export function digestCargoCrate(bytes: Uint8Array): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(bytes);
  return h.digest("hex");
}

export function buildCargoIndexEntry(
  metadata: CargoPublishMetadata,
  checksum: string,
): CargoIndexEntry {
  return {
    name: metadata.name,
    vers: metadata.vers,
    deps: (metadata.deps ?? []).map((dep) => {
      // Renamed deps: in the index, `name` is the name used in Cargo.toml and
      // `package` is the real crate name (the publish payload uses the inverse).
      const renamedName =
        dep.explicit_name_in_toml && dep.explicit_name_in_toml !== dep.name
          ? dep.explicit_name_in_toml
          : null;
      return {
        name: renamedName ?? dep.name,
        req: dep.version_req,
        features: dep.features ?? [],
        optional: Boolean(dep.optional),
        default_features: dep.default_features !== false,
        target: dep.target ?? null,
        kind: dep.kind ?? "normal",
        registry: dep.registry ?? null,
        package: renamedName ? dep.name : null,
      };
    }),
    cksum: checksum,
    features: metadata.features ?? {},
    yanked: false,
    ...(metadata.links ? { links: metadata.links } : {}),
    ...(metadata.rust_version ? { rust_version: metadata.rust_version } : {}),
  };
}
