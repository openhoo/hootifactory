import {
  publishImmutableVersionBlobResponse,
  type RegistryRequestContext,
} from "@hootifactory/registry";
import { chefCookbookUrl } from "./chef-metadata";
import { parseChefPublishRequest } from "./chef-publish";
import { buildChefVersionMeta } from "./chef-validation";

const TARBALL_MEDIA_TYPE = "application/gzip";

/** Stable blob-ref scope for a published cookbook version tarball. */
export function chefBlobScope(name: string, version: string): string {
  return `${name}@${version}`;
}

/** The Supermarket error envelope `{ error_code, error_messages }`. */
function chefError(code: string, messages: string[], status: number): Response {
  return Response.json({ error_code: code, error_messages: messages }, { status });
}

/**
 * Handle `POST /api/v1/cookbooks`: parse the multipart `tarball` + `cookbook`
 * metadata, reject a duplicate version, store the tarball immutably, and respond
 * with the Supermarket-style created envelope.
 */
export async function handleChefPublish(
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const parsed = await parseChefPublishRequest(req);
  if (!parsed.ok) {
    return chefError("INVALID_DATA", parsed.error.errorMessages, parsed.error.status);
  }
  const { metadata, tarball } = parsed.plan;
  const cookbookName = metadata.name;
  if (!cookbookName) {
    return chefError("MISSING_DATA", ["cookbook metadata is missing 'name'"], 400);
  }
  const version = metadata.version;
  const scope = chefBlobScope(cookbookName, version);

  return publishImmutableVersionBlobResponse(ctx, {
    package: { name: cookbookName },
    version,
    kind: "chef_cookbook",
    scope,
    blob: {
      data: tarball,
      kind: "chef_cookbook",
      scope,
      mediaType: TARBALL_MEDIA_TYPE,
    },
    metadata: (stored) => buildChefVersionMeta(metadata, { digest: stored.digest }),
    sizeBytes: tarball.length,
    scan: { name: cookbookName, version, mediaType: TARBALL_MEDIA_TYPE },
    asset: () => ({
      role: "chef_cookbook",
      scope,
      path: `${cookbookName}-${version}.tar.gz`,
      mediaType: TARBALL_MEDIA_TYPE,
      metadata: { cookbook: cookbookName, version },
    }),
    // Cookbook versions are immutable: a re-publish of an existing version conflicts.
    versionConflict: (pkg) => ctx.data.versions.exists(pkg, version),
    conflictResponse: () =>
      chefError(
        "COOKBOOK_VERSION_EXISTS",
        [`cookbook version ${cookbookName} ${version} already exists`],
        409,
      ),
    successResponse: () =>
      // Match Supermarket's `json.uri api_v1_cookbook_url(@cookbook)`: an absolute URL.
      Response.json(
        { uri: chefCookbookUrl(ctx.baseUrl, ctx.repo.mountPath, cookbookName) },
        { status: 201 },
      ),
  });
}
