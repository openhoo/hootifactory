import { and, artifacts, contentManifests, db, eq, inArray } from "@hootifactory/db";
import {
  immutableRegistryBlobCacheControl,
  type RegistryRequestContext,
} from "@hootifactory/registry";
import { blobStore } from "@hootifactory/storage";
import {
  invalidateRegistryScanPolicyCache,
  resolveRegistryScanPolicy,
} from "../governance/scan-policy";

export const REGISTRY_TOKEN_SERVICE = "hootifactory";

type BlobResponseOptions = {
  digest: string;
  contentType: string;
  extraHeaders?: Record<string, string>;
  blocked: () => Response;
  notModified?: () => Response | null;
  redirect?: boolean;
};

function attachmentFilename(digest: string): string {
  return digest.replace(/[^A-Za-z0-9._-]/g, "_");
}

function blobResponseHeaders(ctx: unknown, opts: BlobResponseOptions): Record<string, string> {
  return {
    "cache-control": blobCacheControl(ctx),
    "content-disposition": `attachment; filename="${attachmentFilename(opts.digest)}"`,
    "content-type": opts.contentType,
    etag: `"${opts.digest}"`,
    "x-content-type-options": "nosniff",
    ...opts.extraHeaders,
  };
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
  const [policy, rows] = await Promise.all([
    resolveRegistryScanPolicy(ctx.repo.orgId, ctx.repo.name),
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
  const stateByDigest = new Map(rows.map((row) => [row.digest, row.state]));
  if (policy?.mode === "enforce") {
    // Enforce mode is fail-closed: bytes are unavailable until a scanner has
    // positively marked the artifact clean.
    return uniqueDigests.every((digest) => stateByDigest.get(digest) !== "clean");
  }
  return uniqueDigests.every((digest) => stateByDigest.get(digest) === "blocked");
}

export function invalidateScanPolicyCache(orgId?: string): void {
  invalidateRegistryScanPolicyCache(orgId);
}

export async function loadContentAddressableManifestRaw(input: {
  repositoryId: string;
  digest: string;
}): Promise<{ raw: string } | null> {
  const [manifest] = await db
    .select({ raw: contentManifests.raw })
    .from(contentManifests)
    .where(
      and(
        eq(contentManifests.repositoryId, input.repositoryId),
        eq(contentManifests.digest, input.digest),
      ),
    )
    .limit(1);
  return manifest ?? null;
}

/**
 * Serve a CAS blob's bytes unless scan policy blocks it. The caller supplies the
 * content-type, any extra response headers (e.g. etag), and a `blocked` factory
 * that builds the module-specific 403 response.
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
  const headers = blobResponseHeaders(ctx, opts);
  const read =
    ctx && typeof ctx === "object" && "getBlob" in ctx
      ? (ctx as { getBlob?: (digest: string) => ConstructorParameters<typeof Response>[0] }).getBlob
      : undefined;
  return new Response(read?.(opts.digest) ?? blobStore.get(opts.digest), {
    headers,
  });
}

function blobCacheControl(ctx: unknown): string {
  if (ctx && typeof ctx === "object" && "repo" in ctx && "principal" in ctx) {
    return immutableRegistryBlobCacheControl(ctx as RegistryRequestContext);
  }
  return "private, max-age=31536000, immutable";
}
