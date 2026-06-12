import { SHA256_PREFIX, Sha256HexSchema, z } from "@hootifactory/registry";

/**
 * Git LFS addresses every object by its sha256 OID — a bare 64-char lowercase hex
 * string (no `sha256:` prefix on the wire). We store it in the shared CAS keyed by
 * the canonical `sha256:<oid>` digest, so `oidToDigest`/`digestToOid` translate
 * between the LFS wire form and the platform's digest form.
 */
export const LfsOidSchema = Sha256HexSchema;

/** LFS object sizes are non-negative integers; cap to a sane 53-bit safe maximum. */
export const LfsSizeSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** A single `{ oid, size }` descriptor from a batch request. */
export const LfsBatchObjectSchema = z.object({
  oid: LfsOidSchema,
  size: LfsSizeSchema,
});

/**
 * The Git LFS Batch API request body. `transfers` and `ref` are advisory hints from
 * the client; we only ever speak the `basic` transfer, so they are accepted and
 * ignored. `operation` selects whether we hand back `upload` or `download` actions.
 */
export const LfsBatchRequestSchema = z.object({
  operation: z.enum(["upload", "download"]),
  objects: z.array(LfsBatchObjectSchema).min(1).max(1000),
  transfers: z.array(z.string().max(64)).max(16).optional(),
  ref: z
    .object({ name: z.string().max(512) })
    .loose()
    .optional(),
});

export type LfsBatchRequest = z.output<typeof LfsBatchRequestSchema>;
export type LfsBatchObject = z.output<typeof LfsBatchObjectSchema>;

/** Translate an LFS wire OID into the platform's canonical `sha256:<hex>` digest. */
export function oidToDigest(oid: string): string {
  return `${SHA256_PREFIX}${oid}`;
}

/** Translate a canonical `sha256:<hex>` digest back into an LFS wire OID. */
export function digestToOid(digest: string): string {
  return digest.startsWith(SHA256_PREFIX) ? digest.slice(SHA256_PREFIX.length) : digest;
}
