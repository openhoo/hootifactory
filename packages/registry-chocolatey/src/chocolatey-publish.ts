import { parseRegistryInput } from "@hootifactory/registry";
import { extractMultipartFile, MultipartContentTypeSchema } from "./chocolatey-multipart";
import { extractNuspecMeta } from "./chocolatey-nuspec";
import {
  ChocolateyDependencySchema,
  ChocolateyIdSchema,
  type ChocolateyVersionMeta,
  normalizeChocolateyVersion,
} from "./chocolatey-validation";

export type ChocolateyPublishError = {
  error: string;
  status: 400;
};

export interface ChocolateyPublishPlan {
  id: string;
  lowerId: string;
  version: string;
  scope: string;
  bytes: Uint8Array;
  /** SHA512, base64 — NuGet's PackageHash convention. */
  packageHash: string;
  packageHashAlgorithm: "SHA512";
  metadata: Omit<ChocolateyVersionMeta, "nupkgDigest" | "size">;
}

export type ChocolateyPublishPlanResult =
  | { ok: true; plan: ChocolateyPublishPlan }
  | { ok: false; error: ChocolateyPublishError };

/** The canonical blob/asset scope for a stored .nupkg. */
export function chocolateyBlobScope(lowerId: string, version: string): string {
  return `${lowerId}.${version}.nupkg`;
}

function sha512Base64(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha512");
  hasher.update(bytes);
  return hasher.digest("base64");
}

export async function parseChocolateyPublishRequest(
  req: Request,
): Promise<ChocolateyPublishPlanResult> {
  const packageBytes = await readPackageBytes(req);
  if (!packageBytes.ok) return packageBytes;

  const nuspec = extractNuspecMeta(packageBytes.bytes);
  if (!nuspec) {
    return {
      ok: false,
      error: { error: "could not determine package id and version", status: 400 },
    };
  }

  const id = parseRegistryInput(ChocolateyIdSchema, nuspec.id, {
    code: "MANIFEST_INVALID",
    message: "invalid nuspec package id",
  });
  const version = normalizeChocolateyVersion(nuspec.version);
  if (!version) {
    return { ok: false, error: { error: "invalid package version", status: 400 } };
  }

  // Reject crafted dependency ranges (e.g. ones carrying the reserved OData
  // delimiters `:`/`|`) before persisting, so the feed can never serialize a
  // forged/malformed `<d:Dependencies>` entry. Valid NuGet ranges always pass.
  for (const dep of nuspec.dependencies) {
    if (!ChocolateyDependencySchema.safeParse(dep).success) {
      return { ok: false, error: { error: "invalid nuspec dependency", status: 400 } };
    }
  }

  const lowerId = id.toLowerCase();
  const packageHash = sha512Base64(packageBytes.bytes);
  return {
    ok: true,
    plan: {
      id,
      lowerId,
      version,
      scope: chocolateyBlobScope(lowerId, version),
      bytes: packageBytes.bytes,
      packageHash,
      packageHashAlgorithm: "SHA512",
      metadata: {
        id,
        version,
        packageHash,
        packageHashAlgorithm: "SHA512",
        listed: true,
        ...(nuspec.title ? { title: nuspec.title } : {}),
        ...(nuspec.authors ? { authors: nuspec.authors } : {}),
        ...(nuspec.description ? { description: nuspec.description } : {}),
        ...(nuspec.tags ? { tags: nuspec.tags } : {}),
        ...(nuspec.dependencies.length ? { dependencies: nuspec.dependencies } : {}),
      },
    },
  };
}

async function readPackageBytes(
  req: Request,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: ChocolateyPublishError }> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return { ok: true, bytes: new Uint8Array(await req.arrayBuffer()) };
  }

  parseRegistryInput(MultipartContentTypeSchema, contentType, {
    code: "MANIFEST_INVALID",
    message: "invalid multipart content-type",
  });
  const body = new Uint8Array(await req.arrayBuffer());
  const file = extractMultipartFile(contentType, body);
  if (!file) return { ok: false, error: { error: "missing package", status: 400 } };
  return { ok: true, bytes: file };
}
