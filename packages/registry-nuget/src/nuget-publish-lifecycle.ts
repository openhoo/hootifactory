import { publishImmutableVersionBlob, type RegistryRequestContext } from "@hootifactory/registry";
import { type NugetPublishPlan, parseNugetPublishRequest } from "./nuget-publish";
import type { NugetVersionMeta } from "./nuget-validation";

export function buildNugetPublishedMetadata(
  plan: Pick<NugetPublishPlan, "metadata">,
  digest: string,
): NugetVersionMeta & Record<string, unknown> {
  return {
    ...plan.metadata,
    nupkgDigest: digest,
  };
}

export async function handleNugetPublish(
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const declared = req.headers.get("content-length");
  if (declared) {
    const length = parseInt(declared, 10);
    if (!Number.isNaN(length) && length > ctx.limits.maxUploadBytes) {
      return new Response(null, { status: 413 });
    }
  }

  const parsed = await parseNugetPublishRequest(req);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error.error }, { status: parsed.error.status });
  }
  const { bytes, file, lowerId, version } = parsed.plan;

  const result = await publishImmutableVersionBlob(ctx, {
    package: { name: lowerId },
    version,
    kind: "generic_file",
    scope: file,
    blob: {
      data: bytes,
      kind: "generic_file",
      scope: file,
      mediaType: "application/octet-stream",
    },
    metadata: (stored) => buildNugetPublishedMetadata(parsed.plan, stored.digest),
    sizeBytes: bytes.length,
    scan: {
      name: lowerId,
      version,
      mediaType: "application/octet-stream",
    },
    asset: () => ({
      role: "nuget_package",
      scope: file,
      path: file,
      mediaType: "application/octet-stream",
      metadata: { id: lowerId, version },
    }),
    // NuGet packages are immutable. A retention tombstone still reserves the
    // normalized package version, so old bytes cannot be replaced by re-push.
    versionConflict: async (pkg) => Boolean(await ctx.data.versions.find(pkg, version)),
  });
  if (!result.ok) return new Response(null, { status: 409 });
  return new Response(null, { status: 201 });
}
