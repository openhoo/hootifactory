import type { RegistryRequestContext } from "@hootifactory/registry";
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
  const parsed = await parseNugetPublishRequest(req);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error.error }, { status: parsed.error.status });
  }
  const { bytes, file, lowerId, version } = parsed.plan;

  const pkg = await ctx.data.packages.findOrCreate({
    name: lowerId,
  });
  // NuGet packages are immutable. A retention tombstone still reserves the
  // normalized package version, so old bytes cannot be replaced by re-push.
  const existing = await ctx.data.versions.find(pkg.id, version);
  if (existing) return new Response(null, { status: 409 });

  const stored = await ctx.data.content.storeBlobWithRef({
    data: bytes,
    kind: "generic_file",
    scope: file,
    mediaType: "application/octet-stream",
  });
  const result = await ctx.data.versions.commitOrReleaseBlob({
    stored,
    kind: "generic_file",
    scope: file,
    packageId: pkg.id,
    version,
    metadata: buildNugetPublishedMetadata(parsed.plan, stored.digest),
    sizeBytes: bytes.length,
    scan: {
      name: lowerId,
      version,
      mediaType: "application/octet-stream",
    },
    asset: {
      role: "nuget_package",
      scope: file,
      path: file,
      mediaType: "application/octet-stream",
      metadata: { id: lowerId, version },
    },
  });
  if ("conflict" in result) {
    return new Response(null, { status: 409 });
  }
  return new Response(null, { status: 201 });
}
