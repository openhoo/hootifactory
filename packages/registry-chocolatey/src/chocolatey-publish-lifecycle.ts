import {
  publishImmutableVersionBlobResponse,
  type RegistryRequestContext,
} from "@hootifactory/registry";
import { type ChocolateyPublishPlan, parseChocolateyPublishRequest } from "./chocolatey-publish";
import type { ChocolateyVersionMeta } from "./chocolatey-validation";

export function buildChocolateyPublishedMetadata(
  plan: Pick<ChocolateyPublishPlan, "metadata">,
  digest: string,
  size: number,
): ChocolateyVersionMeta & Record<string, unknown> {
  return {
    ...plan.metadata,
    nupkgDigest: digest,
    size,
  };
}

export async function handleChocolateyPublish(
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const parsed = await parseChocolateyPublishRequest(req);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error.error }, { status: parsed.error.status });
  }
  const { bytes, lowerId, scope, version } = parsed.plan;

  return publishImmutableVersionBlobResponse(ctx, {
    package: { name: lowerId },
    version,
    kind: "generic_file",
    scope,
    blob: {
      data: bytes,
      kind: "generic_file",
      scope,
      mediaType: "application/zip",
    },
    metadata: (stored) =>
      buildChocolateyPublishedMetadata(parsed.plan, stored.digest, bytes.length),
    sizeBytes: bytes.length,
    scan: {
      name: lowerId,
      version,
      mediaType: "application/zip",
    },
    asset: () => ({
      role: "chocolatey_package",
      scope,
      path: scope,
      mediaType: "application/zip",
      metadata: { id: lowerId, version },
    }),
    // Chocolatey/NuGet packages are immutable. A retention tombstone still
    // reserves the normalized version, so old bytes cannot be replaced.
    versionConflict: async (pkg) => Boolean(await ctx.data.versions.find(pkg, version)),
    conflictResponse: () => new Response(null, { status: 409 }),
    successResponse: () => new Response(null, { status: 201 }),
  });
}
