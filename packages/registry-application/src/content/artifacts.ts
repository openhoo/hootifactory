import { and, artifacts, db, eq, inArray, scanPolicies } from "@hootifactory/db";
import {
  immutableRegistryBlobCacheControl,
  type RegistryRequestContext,
} from "@hootifactory/registry";
import { resolveScanPolicy, type ScanPolicyPattern } from "@hootifactory/scan-core";
import { blobStore } from "@hootifactory/storage";

export const REGISTRY_TOKEN_SERVICE = "hootifactory";

type ScanPolicyRow = ScanPolicyPattern & { mode: "audit" | "enforce" };
type BlobResponseOptions = {
  digest: string;
  contentType: string;
  extraHeaders?: Record<string, string>;
  blocked: () => Response;
  notModified?: () => Response | null;
};

function attachmentFilename(digest: string): string {
  return digest.replace(/[^A-Za-z0-9._-]/g, "_");
}

export async function isArtifactBlocked(
  ctx: RegistryRequestContext,
  digest: string,
): Promise<boolean> {
  return areAllArtifactsBlocked(ctx, [digest]);
}

export async function areAllArtifactsBlocked(
  ctx: RegistryRequestContext,
  digests: string[],
): Promise<boolean> {
  const uniqueDigests = [...new Set(digests)];
  if (uniqueDigests.length === 0) return false;
  const [policies, rows] = await Promise.all([
    db.select().from(scanPolicies).where(eq(scanPolicies.orgId, ctx.repo.orgId)),
    db
      .select({ digest: artifacts.digest, state: artifacts.state })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.orgId, ctx.repo.orgId),
          eq(artifacts.repositoryId, ctx.repo.id),
          inArray(artifacts.digest, uniqueDigests),
        ),
      ),
  ]);
  const policy = resolveScanPolicy(policies as ScanPolicyRow[], ctx.repo.name);
  const stateByDigest = new Map(rows.map((row) => [row.digest, row.state]));
  if (policy?.mode === "enforce") {
    // Enforce mode is fail-closed: bytes are unavailable until a scanner has
    // positively marked the artifact clean.
    return uniqueDigests.every((digest) => stateByDigest.get(digest) !== "clean");
  }
  return uniqueDigests.every((digest) => stateByDigest.get(digest) === "blocked");
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
  ctx: unknown,
  opts: BlobResponseOptions,
  isBlocked: (digest: string) => Promise<boolean>,
): Promise<Response> {
  if (await isBlocked(opts.digest)) return opts.blocked();
  const notModified = opts.notModified?.();
  if (notModified) return notModified;
  const read =
    ctx && typeof ctx === "object" && "getBlob" in ctx
      ? (ctx as { getBlob?: (digest: string) => ConstructorParameters<typeof Response>[0] }).getBlob
      : undefined;
  return new Response(read?.(opts.digest) ?? blobStore.get(opts.digest), {
    headers: {
      "cache-control": blobCacheControl(ctx),
      "content-disposition": `attachment; filename="${attachmentFilename(opts.digest)}"`,
      "content-type": opts.contentType,
      etag: `"${opts.digest}"`,
      "x-content-type-options": "nosniff",
      ...opts.extraHeaders,
    },
  });
}

function blobCacheControl(ctx: unknown): string {
  if (ctx && typeof ctx === "object" && "repo" in ctx && "principal" in ctx) {
    return immutableRegistryBlobCacheControl(ctx as RegistryRequestContext);
  }
  return "private, max-age=31536000, immutable";
}
