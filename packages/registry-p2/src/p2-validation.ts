import { z } from "@hootifactory/registry";

/** OSGi Bundle-SymbolicName: letters, digits, dot, underscore, dash. */
export function isValidSymbolicName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name);
}

/** OSGi version: major[.minor[.micro[.qualifier]]]. */
export function isValidOsgiVersion(version: string): boolean {
  return /^\d+(\.\d+(\.\d+(\.[A-Za-z0-9_-]+)?)?)?$/.test(version);
}

export const SymbolicNameSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(isValidSymbolicName, "invalid OSGi symbolic name");

export const OsgiVersionSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(isValidOsgiVersion, "invalid OSGi version");

/** The kind of installable unit a stored jar represents. */
export const P2ArtifactKindSchema = z.enum(["bundle", "feature"]);
export type P2ArtifactKind = z.output<typeof P2ArtifactKindSchema>;

const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/**
 * What we persist per version: the OSGi coordinates plus the blob coordinates the
 * download route resolves against. The package name is the symbolic name and the
 * version is the OSGi version, so both are mirrored here for self-contained reads.
 */
export const P2VersionMetaSchema = z.looseObject({
  symbolicName: SymbolicNameSchema,
  version: OsgiVersionSchema,
  kind: P2ArtifactKindSchema,
  /** The served jar filename (no path separators). */
  filename: z.string().min(1).max(512),
  blobDigest: Sha256DigestSchema,
  sizeBytes: z.number().int().nonnegative(),
});

export type P2VersionMeta = z.output<typeof P2VersionMetaSchema>;

export function parseP2VersionMeta(value: unknown): P2VersionMeta | null {
  const parsed = P2VersionMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The jar filename a published bundle/feature is served under. */
export function jarFilename(symbolicName: string, version: string): string {
  return `${symbolicName}_${version}.jar`;
}

/** Repository-relative directory each kind's jars are served from. */
export function dirForKind(kind: P2ArtifactKind): "plugins" | "features" {
  return kind === "feature" ? "features" : "plugins";
}

/** The blob/asset scope a stored jar lives under: `<dir>/<filename>`. */
export function p2JarScope(kind: P2ArtifactKind, filename: string): string {
  return `${dirForKind(kind)}/${filename}`;
}

/** The p2 artifact classifier for the artifacts.xml entry. */
export function classifierForKind(kind: P2ArtifactKind): string {
  return kind === "feature" ? "org.eclipse.update.feature" : "osgi.bundle";
}

const FILENAME_RE = /^[A-Za-z0-9._-]+\.jar$/;

export const JarFilenameSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.includes("/") && !value.includes("\\"), "invalid filename")
  .refine((value) => FILENAME_RE.test(value), "expected a .jar filename");
