/** Shared, dependency-free types and constants used across packages. */

export type PackageFormat =
  | "npm"
  | "docker"
  | "oci"
  | "pypi"
  | "maven"
  | "helm"
  | "nuget"
  | "go"
  | "cargo"
  | "generic";

export type RepoKind = "hosted" | "proxy" | "virtual";
export type Visibility = "private" | "public";

/** OCI / Docker manifest + config media types. */
export const OCI_MEDIA_TYPES = {
  manifestV1: "application/vnd.oci.image.manifest.v1+json",
  imageIndexV1: "application/vnd.oci.image.index.v1+json",
  configV1: "application/vnd.oci.image.config.v1+json",
  layerTarGzip: "application/vnd.oci.image.layer.v1.tar+gzip",
  emptyV1: "application/vnd.oci.empty.v1+json",
  dockerManifestV2: "application/vnd.docker.distribution.manifest.v2+json",
  dockerManifestListV2: "application/vnd.docker.distribution.manifest.list.v2+json",
  dockerConfigV1: "application/vnd.docker.container.image.v1+json",
  dockerLayerGzip: "application/vnd.docker.image.rootfs.diff.tar.gzip",
} as const;

/** An OCI content descriptor. */
export interface OciDescriptor {
  mediaType: string;
  digest: string;
  size: number;
  urls?: string[];
  annotations?: Record<string, string>;
  artifactType?: string;
  platform?: { architecture: string; os: string; variant?: string };
}

export interface OciManifest {
  schemaVersion: number;
  mediaType?: string;
  artifactType?: string;
  config?: OciDescriptor;
  layers?: OciDescriptor[];
  manifests?: OciDescriptor[];
  subject?: OciDescriptor;
  annotations?: Record<string, string>;
}
