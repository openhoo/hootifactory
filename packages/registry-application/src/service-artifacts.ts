import { and, artifacts, db, eq, scanPolicies } from "@hootifactory/db";
import type { RegistryRequestContext } from "@hootifactory/registry";
import { resolveScanPolicy, type ScanPolicyPattern } from "@hootifactory/scan-core";

export const REGISTRY_TOKEN_SERVICE = "hootifactory";

type ScanPolicyRow = ScanPolicyPattern & { mode: "audit" | "enforce" };
type BlobResponseOptions = {
  digest: string;
  contentType: string;
  extraHeaders?: Record<string, string>;
  blocked: () => Response;
  notModified?: () => Response | null;
};

export async function isArtifactBlocked(
  ctx: RegistryRequestContext,
  digest: string,
): Promise<boolean> {
  const policies = (await db
    .select()
    .from(scanPolicies)
    .where(eq(scanPolicies.orgId, ctx.repo.orgId))) as ScanPolicyRow[];
  const policy = resolveScanPolicy(policies, ctx.repo.name);
  const [row] = await db
    .select({ state: artifacts.state })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.orgId, ctx.repo.orgId),
        eq(artifacts.repositoryId, ctx.repo.id),
        eq(artifacts.digest, digest),
      ),
    )
    .limit(1);
  if (row?.state === "blocked") return true;
  // Enforce mode is fail-closed: bytes are unavailable until a scanner has
  // positively marked the artifact clean.
  if (policy?.mode === "enforce") return row?.state !== "clean";
  return false;
}

/**
 * Serve a CAS blob's bytes unless scan policy blocks it. The caller supplies the
 * content-type, any extra response headers (e.g. etag), and a `blocked` factory
 * that builds the format-specific 403 response.
 *
 * The scan-policy block check ALWAYS runs first. A conditional-GET caller must
 * pass its 304 short-circuit via `notModified` (evaluated only after the block
 * check passes) rather than short-circuiting before the call — otherwise a
 * blocked artifact could be answered with a 304 instead of a 403.
 */
export async function serveBlobIfClean(
  ctx: RegistryRequestContext,
  opts: BlobResponseOptions,
): Promise<Response> {
  return serveBlobWithScanGate(ctx, opts, (digest) => isArtifactBlocked(ctx, digest));
}

export async function serveBlobWithScanGate(
  ctx: Pick<RegistryRequestContext, "blobs">,
  opts: BlobResponseOptions,
  isBlocked: (digest: string) => Promise<boolean>,
): Promise<Response> {
  if (await isBlocked(opts.digest)) return opts.blocked();
  const notModified = opts.notModified?.();
  if (notModified) return notModified;
  return new Response(ctx.blobs.get(opts.digest), {
    headers: { "content-type": opts.contentType, ...opts.extraHeaders },
  });
}
