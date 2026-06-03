import { z } from "@hootifactory/registry";

/** Cargo sparse-index path sharding for a crate name. */
export function cargoIndexPath(name: string): string {
  const n = name.toLowerCase();
  if (n.length === 1) return `1/${n}`;
  if (n.length === 2) return `2/${n}`;
  if (n.length === 3) return `3/${n[0]}/${n}`;
  return `${n.slice(0, 2)}/${n.slice(2, 4)}/${n}`;
}

export function isValidCargoCrateName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name);
}

export function isValidCargoVersion(version: string): boolean {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version,
    );
  if (!match) return false;
  return (match[4] ?? "")
    .split(".")
    .filter(Boolean)
    .every((id) => !/^\d+$/.test(id) || /^(0|[1-9]\d*)$/.test(id));
}

export function cargoVersionIdentity(version: string): string {
  return version.split("+", 1)[0] ?? version;
}

export const CargoCrateNameSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidCargoCrateName, "invalid crate name");

export const CargoVersionSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(isValidCargoVersion, "invalid SemVer");

export const CargoIndexPathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_/-]+$/, "invalid cargo index path");

export const CargoDependencySchema = z.looseObject({
  name: CargoCrateNameSchema,
  version_req: z.string().min(1).max(256),
  features: z.array(z.string().min(1).max(128)).max(256).optional(),
  optional: z.boolean().optional(),
  default_features: z.boolean().optional(),
  target: z.string().min(1).max(256).nullable().optional(),
  kind: z.string().min(1).max(32).optional(),
  registry: z.string().min(1).max(2048).nullable().optional(),
  explicit_name_in_toml: CargoCrateNameSchema.optional(),
});

export const CargoPublishMetadataSchema = z.looseObject({
  name: CargoCrateNameSchema,
  vers: CargoVersionSchema,
  deps: z.array(CargoDependencySchema).max(512).optional(),
  features: z.record(z.string(), z.array(z.string().min(1).max(128)).max(256)).optional(),
  links: z.string().min(1).max(128).nullable().optional(),
  rust_version: z.string().min(1).max(128).nullable().optional(),
});

export const CargoOwnersBodySchema = z.strictObject({
  users: z.array(z.string().min(1).max(256)).max(100),
});

export type CargoPublishMetadata = z.output<typeof CargoPublishMetadataSchema>;

const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const CargoIndexDependencySchema = z.strictObject({
  name: CargoCrateNameSchema,
  req: z.string().min(1).max(256),
  features: z.array(z.string().min(1).max(128)).max(256),
  optional: z.boolean(),
  default_features: z.boolean(),
  target: z.string().min(1).max(256).nullable(),
  kind: z.string().min(1).max(32),
  registry: z.string().min(1).max(2048).nullable(),
  package: CargoCrateNameSchema.nullable(),
});

export const CargoIndexEntrySchema = z.strictObject({
  name: CargoCrateNameSchema,
  vers: CargoVersionSchema,
  deps: z.array(CargoIndexDependencySchema).max(512),
  cksum: Sha256HexSchema,
  features: z.record(z.string(), z.array(z.string().min(1).max(128)).max(256)),
  yanked: z.boolean(),
  links: z.string().min(1).max(128).optional(),
  rust_version: z.string().min(1).max(128).optional(),
});

export const CargoVersionMetaSchema = z.strictObject({
  index: CargoIndexEntrySchema,
  crateDigest: Sha256DigestSchema,
});

export type CargoIndexDependency = z.output<typeof CargoIndexDependencySchema>;
export type CargoIndexEntry = z.output<typeof CargoIndexEntrySchema>;
export type CargoVersionMeta = z.output<typeof CargoVersionMetaSchema>;

export function parseCargoVersionMeta(value: unknown): CargoVersionMeta | null {
  const parsed = CargoVersionMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
