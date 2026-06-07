import { z } from "@hootifactory/registry";

/**
 * Pod names: CocoaPods allows letters, digits, and `+`/`-`/`_`/`.`. Real pod names
 * routinely contain `+` (e.g. `Artsy+OSSUIFonts`). We forbid `/` and `\` so a name
 * can never escape its Specs subtree.
 */
export function isValidPodName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9+._-]*$/.test(name);
}

/** Pod versions are permissive: letters, digits, dot, plus, underscore, dash. */
export function isValidPodVersion(version: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(version);
}

export const PodNameSchema = z.string().min(1).max(128).refine(isValidPodName, "invalid pod name");

export const PodVersionSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(isValidPodVersion, "invalid pod version");

/**
 * The three-level sharded Specs path CocoaPods' CDN uses. `a`/`b`/`c` are the first
 * three hex characters of `md5(podName)`, so a pod lands at
 * `Specs/<a>/<b>/<c>/<pod>/<version>/<pod>.podspec.json`.
 */
export function podShardPrefix(podName: string): [string, string, string] {
  const hasher = new Bun.CryptoHasher("md5");
  hasher.update(podName);
  const hex = hasher.digest("hex");
  return [hex[0] as string, hex[1] as string, hex[2] as string];
}

/** The sharded Specs directory for a pod, e.g. `Specs/a/7/5/AFNetworking`. */
export function podSpecsDir(podName: string): string {
  const [a, b, c] = podShardPrefix(podName);
  return `Specs/${a}/${b}/${c}/${podName}`;
}

/** The full Specs path to a pod version's `podspec.json`. */
export function podSpecPath(podName: string, version: string): string {
  return `${podSpecsDir(podName)}/${version}/${podName}.podspec.json`;
}

/** The artifact filename CocoaPods clients download. */
export function podArtifactFilename(podName: string, version: string): string {
  return `${podName}-${version}.tar.gz`;
}

const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * The publish-side `podspec` part. CocoaPods podspecs carry arbitrary descriptive
 * fields; we keep the document loose but require `name`/`version` and reject any
 * publisher-supplied `source` (the server rewrites `source` to the hosted download
 * URL, so a publisher must not be able to point clients elsewhere).
 */
export const PodspecPublishSchema = z
  .looseObject({
    name: PodNameSchema,
    version: PodVersionSchema,
    source: z.unknown().optional(),
  })
  .transform((spec) => {
    // Never persist a publisher `source`; it is recomputed to the hosted URL on read.
    const { source: _source, ...rest } = spec;
    return rest as Record<string, unknown> & { name: string; version: string };
  });

export type PodspecPublish = z.output<typeof PodspecPublishSchema>;

/**
 * What we persist per version: the publisher's podspec document (with `source`
 * stripped) plus the blob coordinates the download route resolves against.
 */
export const PodVersionMetaSchema = z.looseObject({
  podspec: z.looseObject({ name: PodNameSchema, version: PodVersionSchema }),
  blobDigest: Sha256DigestSchema,
  sha256: Sha256HexSchema,
  filename: z.string().min(1).max(512),
});

export type PodVersionMeta = z.output<typeof PodVersionMetaSchema>;

export function parsePodVersionMeta(value: unknown): PodVersionMeta | null {
  const parsed = PodVersionMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Persist the podspec document (without computed source) alongside blob coordinates. */
export function buildPodVersionMeta(
  podspec: PodspecPublish,
  blob: { digest: string; sha256: string; filename: string },
): PodVersionMeta & Record<string, unknown> {
  return {
    podspec,
    blobDigest: blob.digest,
    sha256: blob.sha256,
    filename: blob.filename,
  };
}

/**
 * The served `<pod>.podspec.json` body: the stored podspec document with its
 * `source` rewritten to the hosted `:http` download URL plus the integrity
 * `:sha256` of the stored archive (so CocoaPods verifies the hosted blob).
 */
export function buildServedPodspec(
  meta: PodVersionMeta,
  downloadUrl: string,
): Record<string, unknown> {
  return {
    ...meta.podspec,
    source: { http: downloadUrl, sha256: meta.sha256 },
  };
}
