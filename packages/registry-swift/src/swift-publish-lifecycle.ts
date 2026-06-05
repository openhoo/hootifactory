import {
  asJsonRecord,
  digestHex,
  findRegistryPackage,
  publishImmutableVersionBlob,
  type RegistryRequestContext,
  type RegistryStoredBlob,
} from "@hootifactory/registry";
import { extractPackageManifest } from "./swift-manifest";
import { parseSwiftMultipart } from "./swift-multipart";
import { type SwiftVersionMeta, swiftArchiveScope, swiftPackageId } from "./swift-validation";

const MAX_PUBLISH_BYTES = 256 * 1024 * 1024;

export interface SwiftPublishPlan {
  archive: Uint8Array;
  metadata: Record<string, unknown>;
  manifest?: string;
}

export type SwiftPublishParseResult =
  | { ok: true; plan: SwiftPublishPlan }
  | { ok: false; status: number; detail: string };

function decodeJsonMetadata(bytes: Uint8Array): Record<string, unknown> | null {
  if (bytes.byteLength === 0) return {};
  try {
    return asJsonRecord(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
}

/** Parse the SwiftPM publish multipart body into a normalized plan. */
export async function parseSwiftPublishRequest(req: Request): Promise<SwiftPublishParseResult> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return { ok: false, status: 415, detail: "expected multipart/form-data body" };
  }
  const body = new Uint8Array(await req.arrayBuffer());
  if (body.byteLength > MAX_PUBLISH_BYTES) {
    return { ok: false, status: 413, detail: "source archive too large" };
  }
  const parts = parseSwiftMultipart(contentType, body);
  if (!parts) {
    return { ok: false, status: 400, detail: "malformed multipart body" };
  }

  const archive = parts.find((part) => part.name === "source-archive")?.bytes;
  if (!archive || archive.byteLength === 0) {
    return { ok: false, status: 422, detail: "missing source-archive part" };
  }

  const metadataPart = parts.find((part) => part.name === "metadata")?.bytes;
  const metadata = metadataPart ? decodeJsonMetadata(metadataPart) : {};
  if (metadata === null) {
    return { ok: false, status: 400, detail: "metadata part is not a JSON object" };
  }

  return {
    ok: true,
    plan: {
      // Copy out of the multipart buffer so the archive is independently retained.
      archive: archive.slice(),
      metadata,
      manifest: extractPackageManifest(archive) ?? undefined,
    },
  };
}

export function buildSwiftVersionMetadata(
  plan: SwiftPublishPlan,
  stored: RegistryStoredBlob,
): SwiftVersionMeta {
  return {
    archiveDigest: stored.digest,
    checksum: digestHex(stored.digest),
    metadata: plan.metadata,
    ...(plan.manifest !== undefined ? { manifest: plan.manifest } : {}),
  };
}

export interface SwiftPublishResult {
  status: number;
  detail?: string;
  location?: string;
  checksum?: string;
}

/** Publish a release: store the archive immutably and commit version metadata. */
export async function handleSwiftPublish(
  scope: string,
  name: string,
  version: string,
  req: Request,
  ctx: RegistryRequestContext,
): Promise<SwiftPublishResult> {
  const parsed = await parseSwiftPublishRequest(req);
  if (!parsed.ok) {
    return { status: parsed.status, detail: parsed.detail };
  }
  const packageId = swiftPackageId(scope, name);
  const scopeKey = swiftArchiveScope(scope, name, version);

  // Reject re-publishing an existing release before we touch the blob store.
  const existing = await findRegistryPackage(ctx, packageId);
  if (existing && (await ctx.data.versions.exists(existing, version))) {
    return { status: 409, detail: "version already exists" };
  }

  const result = await publishImmutableVersionBlob(ctx, {
    // `packageId` is the case-normalized identifier; the namespace mirrors it so
    // a package published as mona/LinkedList resolves under Mona/linkedlist too.
    package: { name: packageId, namespace: scope.toLowerCase() },
    version,
    kind: "swift_archive",
    scope: scopeKey,
    blob: {
      data: parsed.plan.archive,
      kind: "swift_archive",
      scope: scopeKey,
      mediaType: "application/zip",
    },
    metadata: (stored) => buildSwiftVersionMetadata(parsed.plan, stored),
    sizeBytes: parsed.plan.archive.byteLength,
    scan: { name: packageId, version, mediaType: "application/zip" },
    asset: (stored) => ({
      role: "swift_archive",
      scope: scopeKey,
      path: `${name}-${version}.zip`,
      mediaType: "application/zip",
      metadata: { packageId, checksum: digestHex(stored.digest) },
    }),
    versionConflict: (pkg) => ctx.data.versions.exists(pkg, version),
  });
  if (!result.ok) {
    return { status: 409, detail: "version already exists" };
  }
  return {
    status: 201,
    location: `${ctx.baseUrl}/${ctx.repo.mountPath}/${scope}/${name}/${version}`,
    checksum: digestHex(result.stored.digest),
  };
}
