import { parseRegistryInput } from "@hootifactory/registry";
import { extractMultipartFile, MultipartContentTypeSchema } from "./nuget-multipart";
import {
  isSemVer2NugetVersion,
  NugetIdSchema,
  NugetPublishQuerySchema,
  type NugetVersionMeta,
  normalizeNugetVersion,
} from "./nuget-validation";
import { extractNuspecMeta } from "./nuspec";

export type NugetPublishError = {
  error: string;
  status: 400;
};

export interface NugetPublishPlan {
  id: string;
  lowerId: string;
  version: string;
  file: string;
  bytes: Uint8Array;
  metadata: Omit<NugetVersionMeta, "nupkgDigest">;
}

export type NugetPublishPlanResult =
  | { ok: true; plan: NugetPublishPlan }
  | { ok: false; error: NugetPublishError };

export async function parseNugetPublishRequest(req: Request): Promise<NugetPublishPlanResult> {
  const url = new URL(req.url);
  const query = parseRegistryInput(
    NugetPublishQuerySchema,
    {
      id: url.searchParams.get("id") || undefined,
      version: url.searchParams.get("version") || undefined,
    },
    { code: "MANIFEST_INVALID", message: "invalid publish query" },
  );

  const packageBytes = await readNugetPackageBytes(req);
  if (!packageBytes.ok) return packageBytes;

  const nuspec = extractNuspecMeta(packageBytes.bytes);
  if (!nuspec) {
    return {
      ok: false,
      error: { error: "could not determine package id and version", status: 400 },
    };
  }

  const nuspecId = parseRegistryInput(NugetIdSchema, nuspec.id, {
    code: "MANIFEST_INVALID",
    message: "invalid nuspec package id",
  });
  if (query.id && query.id.toLowerCase() !== nuspecId.toLowerCase()) {
    return { ok: false, error: { error: "package id does not match nuspec", status: 400 } };
  }

  const normalizedNuspecVersion = normalizeNugetVersion(nuspec.version);
  const normalizedQueryVersion = query.version
    ? normalizeNugetVersion(query.version)
    : normalizedNuspecVersion;
  if (!normalizedNuspecVersion || !normalizedQueryVersion) {
    return { ok: false, error: { error: "invalid package version", status: 400 } };
  }
  if (normalizedQueryVersion !== normalizedNuspecVersion) {
    return { ok: false, error: { error: "package version does not match nuspec", status: 400 } };
  }

  const id = query.id ?? nuspecId;
  const lowerId = id.toLowerCase();
  const version = normalizedNuspecVersion;
  return {
    ok: true,
    plan: {
      id,
      lowerId,
      version,
      file: `${lowerId}.${version}.nupkg`,
      bytes: packageBytes.bytes,
      metadata: {
        file: `${lowerId}.${version}.nupkg`,
        displayId: id,
        listed: true,
        semVer2: isSemVer2NugetVersion(nuspec.version),
        dependencyGroups: nuspec.dependencyGroups,
      },
    },
  };
}

async function readNugetPackageBytes(
  req: Request,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: NugetPublishError }> {
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
