import type { PackageFormat } from "@hootifactory/types";

const V2_FORMATS = new Set<PackageFormat>(["docker", "oci", "helm"]);
const OCI_REPOSITORY_NAME_RE =
  /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*)*$/;

/** First URL segment for a format: "v2" for OCI-based, else the format name. */
export function mountSegment(format: PackageFormat): string {
  return V2_FORMATS.has(format) ? "v2" : format;
}

export function computeMountPath(format: PackageFormat, orgSlug: string, repoName: string): string {
  return `${mountSegment(format)}/${orgSlug}/${repoName}`;
}

export function isValidRepositoryName(name: string): boolean {
  if (name.length === 0 || name.length > 256) return false;
  if (name.includes("..")) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

export function isValidRepositoryNameForFormat(format: PackageFormat, name: string): boolean {
  if (!isValidRepositoryName(name)) return false;
  return V2_FORMATS.has(format) ? OCI_REPOSITORY_NAME_RE.test(name) : true;
}
