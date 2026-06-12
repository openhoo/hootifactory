import { Sha256DigestSchema, Sha256HexSchema, z } from "@hootifactory/registry";

/**
 * Vagrant box names are `:user/:box`. Each segment accepts letters (either case),
 * digits, dot, underscore, and dash, mirroring what the client and Vagrant Cloud
 * permit.
 */
const NAME_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
/** Box versions are SemVer-ish: letters, digits, dot, plus, underscore, dash. */
const VERSION_RE = /^[A-Za-z0-9.+_-]+$/;
/** Provider names, e.g. `virtualbox`, `vmware_desktop`, `libvirt`, `hyperv`. */
const PROVIDER_RE = /^[A-Za-z0-9._-]+$/;

export function isValidVagrantNameSegment(value: string): boolean {
  return NAME_SEGMENT_RE.test(value);
}

export function isValidVagrantVersion(version: string): boolean {
  return VERSION_RE.test(version);
}

export function isValidVagrantProvider(provider: string): boolean {
  return PROVIDER_RE.test(provider);
}

export const VagrantNameSegmentSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(NAME_SEGMENT_RE, "invalid Vagrant name segment");

export const VagrantVersionSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(VERSION_RE, "invalid Vagrant box version");

export const VagrantProviderSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(PROVIDER_RE, "invalid Vagrant provider name");

/**
 * One provider's `.box` artifact stored under a box version. The blob coordinates
 * (`blobDigest`) resolve the download route; `sha256` is the bare hex advertised
 * to the Vagrant client as the box checksum.
 */
export const VagrantProviderFileSchema = z.strictObject({
  blobDigest: Sha256DigestSchema,
  sha256: Sha256HexSchema,
  /**
   * Stored bytes of this provider's blob. Optional for backward compatibility with
   * metadata written before sizes were tracked; the version total is recomputed
   * from the sum of these on every publish.
   */
  sizeBytes: z.number().int().nonnegative().optional(),
});

export type VagrantProviderFile = z.output<typeof VagrantProviderFileSchema>;

/**
 * The metadata persisted per box version. A version owns one or more providers
 * keyed by provider name, plus the optional `description` carried at box level.
 */
export const VagrantVersionMetaSchema = z.strictObject({
  description: z.string().max(2048).optional(),
  providers: z.record(VagrantProviderSchema, VagrantProviderFileSchema),
});

export type VagrantVersionMeta = z.output<typeof VagrantVersionMetaSchema>;

export function parseVagrantVersionMeta(value: unknown): VagrantVersionMeta | null {
  const parsed = VagrantVersionMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A version's stored size is the sum of its providers' blob sizes (known ones). */
export function versionSizeBytes(meta: VagrantVersionMeta): number {
  let total = 0;
  for (const provider of Object.values(meta.providers)) total += provider.sizeBytes ?? 0;
  return total;
}

/** Blob-ref kind / asset role under which every `.box` blob is stored. */
export const BOX_ASSET_ROLE = "vagrant_box";
/** Content type advertised for and stored against every `.box` blob. */
export const BOX_MEDIA_TYPE = "application/octet-stream";
/** Vagrant Cloud reports box checksums as sha256; we mirror that constant. */
export const CHECKSUM_TYPE = "sha256";

/** Stable per-provider blob-ref / asset scope (one per provider of a box version). */
export function boxScope(name: string, version: string, provider: string): string {
  return `${name}@${version}/${provider}`;
}

/** One provider entry in the served box metadata. */
export interface VagrantMetadataProvider {
  name: string;
  url: string;
  checksum_type: string;
  checksum: string;
}

/** One version entry in the served box metadata. */
export interface VagrantMetadataVersion {
  version: string;
  providers: VagrantMetadataProvider[];
}

/** The `GET /:user/:box` body the Vagrant client consumes. */
export interface VagrantBoxMetadata {
  name: string;
  description?: string;
  versions: VagrantMetadataVersion[];
}

/**
 * One provider entry in the Vagrant Cloud box-read response. The Cloud API names
 * the download field `download_url` (vs. `url` in the box-catalog document) and
 * carries the checksum on the same provider object, so `vagrant box add user/box`
 * can resolve, download, and verify a short box name in one read.
 */
export interface VagrantCloudProvider {
  name: string;
  download_url: string;
  checksum_type: string;
  checksum: string;
}

/** One version entry in the Vagrant Cloud box-read response. */
export interface VagrantCloudVersion {
  version: string;
  providers: VagrantCloudProvider[];
}

/**
 * The `GET /api/v1/box/:user/:box` body. A Vagrant-Cloud-compatible read alias for
 * short-name resolution (`config.vm.box = "user/box"` / `vagrant box add user/box`
 * against `VAGRANT_SERVER_URL`). Mirrors the catalog metadata, re-keyed to the
 * Cloud field names the modern client (vagrant_cloud gem / go-vagrant) expects.
 */
export interface VagrantCloudBox {
  tag: string;
  name: string;
  description?: string;
  versions: VagrantCloudVersion[];
}

/**
 * Build a single version's metadata block from its stored providers. `downloadUrl`
 * resolves a provider name to its absolute hosted download endpoint.
 */
export function buildVagrantMetadataVersion(
  version: string,
  meta: VagrantVersionMeta,
  downloadUrl: (provider: string) => string,
): VagrantMetadataVersion {
  // Deterministic provider ordering keeps the metadata document stable for ETags.
  const entries = Object.entries(meta.providers).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const providers: VagrantMetadataProvider[] = entries.map(([provider, file]) => ({
    name: provider,
    url: downloadUrl(provider),
    checksum_type: CHECKSUM_TYPE,
    checksum: file.sha256,
  }));
  return { version, providers };
}

/**
 * Build one version block of the Vagrant Cloud box-read response from its stored
 * providers, re-keying the catalog `url` field to the Cloud `download_url` (the
 * URL itself is identical — both point at the hosted `GET /:user/:box/:version/:provider`
 * download route). Provider ordering matches the catalog document so both reads
 * stay deterministic.
 */
export function buildVagrantCloudVersion(
  version: string,
  meta: VagrantVersionMeta,
  downloadUrl: (provider: string) => string,
): VagrantCloudVersion {
  const entries = Object.entries(meta.providers).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const providers: VagrantCloudProvider[] = entries.map(([provider, file]) => ({
    name: provider,
    download_url: downloadUrl(provider),
    checksum_type: CHECKSUM_TYPE,
    checksum: file.sha256,
  }));
  return { version, providers };
}
