import { env } from "@hootifactory/config";
import {
  basicAuthChallenge,
  commitVersionOrReleaseBlob,
  Errors,
  type FormatAdapter,
  type FormatMetadata,
  findLiveVersion,
  findOrCreatePackage,
  findPackageByName,
  type HttpMethod,
  type Permission,
  parseRegistryInput,
  type RepoContext,
  type RouteEntry,
  type RouteMatch,
  safeFetch,
  serveBlobIfClean,
  setDistTag,
  storeBlobWithRef,
  upsertPackageVersion,
  upsertPackageVersionWithBlobRef,
} from "@hootifactory/core";
import {
  and,
  count,
  desc,
  eq,
  isNull,
  like,
  packages,
  packageVersions,
  sql,
  versionTags,
} from "@hootifactory/db";
import { ifNoneMatch, responseBytes, responseJson } from "./npm-http";
import {
  type NpmDist,
  sha1hex,
  sha1hexText,
  sha512b64,
  upstreamDistMatchesBytes,
  upstreamDistMatchesStored,
} from "./npm-integrity";
import {
  buildNpmMirroredDist,
  isNpmTarballUrlOnUpstreamHost,
  type NpmUpstreamPackument,
  normalizeNpmProxyManifest,
  npmUpstreamHost,
  npmUpstreamPackumentUrl,
  rewriteNpmProxyManifestForExistingDist,
} from "./npm-proxy";
import { parseNpmPublishRequest, resolveNpmPublishDistTags } from "./npm-publish";
import {
  buildNpmSearchObject,
  buildNpmSearchResponse,
  type NpmSearchObject,
  parseNpmSearchQuery,
} from "./npm-search";
import {
  basename,
  isValidDistTag,
  isValidLegacyNpmName,
  isValidNpmVersion,
  NpmDistTagSchema,
  NpmLegacyPackageNameSchema,
  NpmTarballFilenameSchema,
  NpmVersionSchema,
  packagePath,
} from "./npm-validation";
import { buildPackument, mergePackuments } from "./packument";

function parseNpmName(name: string): string {
  return parseRegistryInput(NpmLegacyPackageNameSchema, name, {
    code: "NAME_INVALID",
    message: "invalid package name",
  });
}

function parseNpmVersion(version: string): string {
  return parseRegistryInput(NpmVersionSchema, version, {
    code: "MANIFEST_INVALID",
    message: "invalid package version",
  });
}

export class NpmAdapter implements FormatAdapter {
  readonly format = "npm" as const;
  readonly capabilities = {
    contentAddressable: false,
    resumableUploads: false,
    proxyable: true,
    virtualizable: true,
  };

  routes(): RouteEntry[] {
    return [
      { method: "GET", pattern: "/-/ping", handlerId: "ping" },
      { method: "GET", pattern: "/-/whoami", handlerId: "whoami" },
      { method: "GET", pattern: "/-/v1/search", handlerId: "search" },
      { method: "POST", pattern: "/-/npm/v1/security/advisories/bulk", handlerId: "auditBulk" },
      { method: "POST", pattern: "/-/npm/v1/security/audits/quick", handlerId: "auditQuick" },
      { method: "GET", pattern: "/-/package/:pkg+/dist-tags", handlerId: "distTagsList" },
      { method: "PUT", pattern: "/-/package/:pkg+/dist-tags/:tag", handlerId: "distTagSet" },
      { method: "DELETE", pattern: "/-/package/:pkg+/dist-tags/:tag", handlerId: "distTagDelete" },
      { method: "GET", pattern: "/:pkg+/-/:filename", handlerId: "tarball" },
      { method: "PUT", pattern: "/:pkg+", handlerId: "publish" },
      { method: "GET", pattern: "/:pkg+", handlerId: "packument" },
    ];
  }

  requiredPermission(method: HttpMethod, match?: RouteMatch): Permission {
    return {
      action:
        method === "GET" || method === "HEAD" || match?.entry.handlerId.startsWith("audit")
          ? "read"
          : "write",
    };
  }

  authChallenge = basicAuthChallenge;

  async handle(match: RouteMatch, req: Request, ctx: RepoContext): Promise<Response> {
    switch (match.entry.handlerId) {
      case "ping":
        return Response.json({});
      case "whoami":
        return Response.json({
          username: this.whoamiUsername(ctx),
        });
      case "search":
        return this.searchHandler(req, ctx);
      case "auditBulk":
        return Response.json({});
      case "auditQuick":
        return Response.json({ advisories: {}, vulnerabilities: {}, metadata: {} });
      case "packument":
        return this.packument(match.params.pkg ?? "", req, ctx);
      case "tarball":
        return this.tarball(match.params.pkg ?? "", match.params.filename ?? "", req, ctx);
      case "publish":
        return this.publish(match.params.pkg ?? "", req, ctx);
      case "distTagsList":
        return this.distTagsList(match.params.pkg ?? "", ctx);
      case "distTagSet":
        return this.distTagSet(match.params.pkg ?? "", match.params.tag ?? "", req, ctx);
      case "distTagDelete":
        return this.distTagDelete(match.params.pkg ?? "", match.params.tag ?? "", ctx);
      default:
        throw Errors.notFound();
    }
  }

  private async findPackage(ctx: RepoContext, name: string) {
    return findPackageByName(ctx, name);
  }

  private async liveVersions(ctx: RepoContext, packageId: string) {
    return ctx.db
      .select()
      .from(packageVersions)
      .where(and(eq(packageVersions.packageId, packageId), isNull(packageVersions.deletedAt)));
  }

  private async distTags(ctx: RepoContext, packageId: string): Promise<Record<string, string>> {
    const rows = await ctx.db
      .select({ tag: versionTags.tag, version: packageVersions.version })
      .from(versionTags)
      .innerJoin(packageVersions, eq(versionTags.versionId, packageVersions.id))
      .where(and(eq(versionTags.packageId, packageId), isNull(packageVersions.deletedAt)));
    const out: Record<string, string> = {};
    for (const r of rows) out[r.tag] = r.version;
    return out;
  }

  private whoamiUsername(ctx: RepoContext): string {
    const principal = ctx.principal;
    if (principal.kind === "user") return principal.username;
    if (principal.kind === "registryToken") return principal.subject;
    if (principal.kind === "token") {
      return principal.ownerUsername ?? principal.tokenName ?? `token:${principal.tokenId}`;
    }
    return "anonymous";
  }

  async generateMetadata(name: string, ctx: RepoContext): Promise<FormatMetadata | null> {
    name = parseNpmName(name);
    const pkg = await this.findPackage(ctx, name);
    if (!pkg) return null;
    const versions = await this.liveVersions(ctx, pkg.id);
    const tags = await this.distTags(ctx, pkg.id);
    return {
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(buildPackument(name, versions, tags)),
    };
  }

  async mergeMetadata(parts: FormatMetadata[]): Promise<FormatMetadata> {
    return mergePackuments(parts);
  }

  private async packument(name: string, req: Request, ctx: RepoContext): Promise<Response> {
    name = parseNpmName(name);
    const pkg = await this.findPackage(ctx, name);
    if (!pkg) return Response.json({ error: "Not found" }, { status: 404 });
    const versions = await this.liveVersions(ctx, pkg.id);
    const tags = await this.distTags(ctx, pkg.id);
    const body = JSON.stringify(buildPackument(name, versions, tags));
    const etag = `"${sha1hexText(body)}"`;
    if (ifNoneMatch(req, etag)) return new Response(null, { status: 304, headers: { etag } });
    return new Response(body, {
      headers: { "content-type": "application/json; charset=utf-8", etag },
    });
  }

  private async tarball(
    name: string,
    filename: string,
    req: Request,
    ctx: RepoContext,
  ): Promise<Response> {
    name = parseNpmName(name);
    filename = parseRegistryInput(NpmTarballFilenameSchema, filename, {
      code: "NAME_INVALID",
      message: "invalid tarball filename",
    });
    const pkg = await this.findPackage(ctx, name);
    if (!pkg) return Response.json({ error: "Not found" }, { status: 404 });
    const versions = await this.liveVersions(ctx, pkg.id);
    const match = versions.find(
      (v) => (v.metadata as { dist?: NpmDist })?.dist?.filename === filename,
    );
    const dist = (match?.metadata as { dist?: NpmDist } | undefined)?.dist;
    if (!dist || !(await ctx.blobs.exists(dist.blobDigest))) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    const etag = `"${dist.shasum}"`;
    return serveBlobIfClean(ctx, {
      digest: dist.blobDigest,
      contentType: "application/octet-stream",
      extraHeaders: { etag },
      blocked: () => Response.json({ error: "artifact blocked by scan policy" }, { status: 403 }),
      notModified: () =>
        ifNoneMatch(req, etag) ? new Response(null, { status: 304, headers: { etag } }) : null,
    });
  }

  private async publish(name: string, req: Request, ctx: RepoContext): Promise<Response> {
    const rawBody = await req.json().catch(() => null);
    const parsed = parseNpmPublishRequest(name, rawBody);
    if (!parsed.ok) {
      return Response.json({ error: parsed.error.error }, { status: parsed.error.status });
    }
    if (parsed.plan.kind === "metadataOnly") {
      return this.updateMetadataOnly(
        parsed.plan.name,
        parsed.plan.versions,
        parsed.plan.distTags,
        ctx,
      );
    }

    name = parsed.plan.name;
    const publishVersions = parsed.plan.versions;
    const distTags = parsed.plan.distTags;
    const existingPkg = await this.findPackage(ctx, name);
    const distTagTargets = await resolveNpmPublishDistTags(
      distTags,
      publishVersions.map((version) => version.version),
      (version) =>
        existingPkg ? this.versionId(ctx, existingPkg.id, version) : Promise.resolve(null),
    );
    if (!distTagTargets.ok) {
      return Response.json({ error: distTagTargets.error }, { status: 400 });
    }

    const scope = name.startsWith("@") ? (name.split("/")[0] ?? null) : null;
    const base = basename(name);
    const pkg =
      existingPkg ??
      (await findOrCreatePackage({
        orgId: ctx.repo.orgId,
        repositoryId: ctx.repo.id,
        name,
        namespace: scope,
      }));
    const versionIds = new Map<string, string>();

    // Any version row, including a retention tombstone, reserves the npm version.
    // Retention hides bytes from readers; it must not make immutable versions
    // publishable again.
    const used = await ctx.db
      .select({ version: packageVersions.version })
      .from(packageVersions)
      .where(eq(packageVersions.packageId, pkg.id));
    const usedSet = new Set(used.map((v) => v.version));

    for (const { version: ver, manifest, tarball } of publishVersions) {
      if (usedSet.has(ver)) {
        return Response.json(
          { error: `cannot publish over the previously published version ${ver}` },
          { status: 403 },
        );
      }
      const shasum = sha1hex(tarball);
      const integrity = `sha512-${sha512b64(tarball)}`;
      const filename = `${base}-${ver}.tgz`;
      const stored = await storeBlobWithRef(ctx, {
        data: tarball,
        kind: "npm_tarball",
        scope: `${name}@${ver}`,
        mediaType: "application/octet-stream",
      });
      const tarballUrl = `${ctx.baseUrl}/${ctx.repo.mountPath}/${packagePath(name)}/-/${filename}`;
      manifest.dist = {
        ...((manifest.dist as Record<string, unknown>) ?? {}),
        tarball: tarballUrl,
        shasum,
        integrity,
      };
      const dist: NpmDist = {
        filename,
        blobDigest: stored.digest,
        shasum,
        integrity,
        size: tarball.length,
      };
      const result = await commitVersionOrReleaseBlob(ctx, {
        stored,
        kind: "npm_tarball",
        scope: `${name}@${ver}`,
        packageId: pkg.id,
        version: ver,
        metadata: { manifest, dist },
        sizeBytes: tarball.length,
        scan: { name, version: ver, mediaType: "application/octet-stream" },
      });
      if ("conflict" in result) {
        return Response.json(
          { error: `cannot publish over the previously published version ${ver}` },
          { status: 403 },
        );
      }
      versionIds.set(ver, result.versionId);
    }

    for (const [tag, ver] of Object.entries(distTags)) {
      const versionId = versionIds.get(ver) ?? distTagTargets.existingVersionIds.get(ver);
      if (!versionId) throw new Error(`validated npm dist-tag ${tag} lost version ${ver}`);
      await setDistTag(ctx, pkg.id, tag, versionId);
    }
    if (distTags.latest) {
      await ctx.db
        .update(packages)
        .set({ latestVersion: distTags.latest })
        .where(eq(packages.id, pkg.id));
    }

    return Response.json({ success: true }, { status: 201 });
  }

  private async versionId(ctx: RepoContext, packageId: string, version: string) {
    return (await findLiveVersion(ctx, packageId, version))?.id ?? null;
  }

  private async updateMetadataOnly(
    name: string,
    incomingVersions: Record<string, Record<string, unknown>>,
    distTags: Record<string, string>,
    ctx: RepoContext,
  ): Promise<Response> {
    const entries = Object.entries(incomingVersions);
    if (!entries.length) {
      return Response.json({ error: "publish payload must include a version" }, { status: 400 });
    }

    const pkg = await this.findPackage(ctx, name);
    if (!pkg) {
      return Response.json(
        { error: `missing tarball attachment for ${entries[0]![0]}` },
        { status: 400 },
      );
    }

    const liveRows = await this.liveVersions(ctx, pkg.id);
    const liveByVersion = new Map(liveRows.map((row) => [row.version, row]));
    const versionIds = new Map<string, string>();
    for (const [ver, manifestRaw] of entries) {
      parseNpmVersion(ver);
      const live = liveByVersion.get(ver);
      if (!live) return Response.json({ error: `version not found: ${ver}` }, { status: 404 });
      if (manifestRaw.name !== undefined && manifestRaw.name !== name) {
        return Response.json(
          { error: "version manifest name does not match URL" },
          { status: 400 },
        );
      }
      if (manifestRaw.version !== undefined && manifestRaw.version !== ver) {
        return Response.json(
          { error: "version manifest version does not match version key" },
          { status: 400 },
        );
      }
      versionIds.set(ver, live.id);
      if (!Object.hasOwn(manifestRaw, "deprecated")) continue;

      const metadata = (live.metadata as Record<string, unknown> | null) ?? {};
      const manifest = (metadata.manifest as Record<string, unknown> | undefined) ?? {
        name,
        version: ver,
      };
      await upsertPackageVersion(ctx, {
        packageId: pkg.id,
        version: ver,
        metadata: {
          ...metadata,
          manifest: {
            ...manifest,
            name,
            version: ver,
            deprecated: manifestRaw.deprecated,
          },
        },
        sizeBytes: live.sizeBytes,
      });
    }

    for (const [tag, ver] of Object.entries(distTags)) {
      parseRegistryInput(NpmDistTagSchema, tag, {
        code: "TAG_INVALID",
        message: "invalid dist-tag",
      });
      parseRegistryInput(NpmVersionSchema, ver, {
        code: "MANIFEST_INVALID",
        message: `dist-tag ${tag} points to an invalid version`,
      });
      const versionId = versionIds.get(ver) ?? (await this.versionId(ctx, pkg.id, ver));
      if (!versionId) {
        return Response.json(
          { error: `dist-tag ${tag} points to an unknown version` },
          { status: 400 },
        );
      }
      await setDistTag(ctx, pkg.id, tag, versionId);
      if (tag === "latest") {
        await ctx.db.update(packages).set({ latestVersion: ver }).where(eq(packages.id, pkg.id));
      }
    }

    return Response.json({ success: true }, { status: 200 });
  }

  private async distTagsList(name: string, ctx: RepoContext): Promise<Response> {
    name = parseNpmName(name);
    const pkg = await this.findPackage(ctx, name);
    if (!pkg) return Response.json({}, { status: 404 });
    return Response.json(await this.distTags(ctx, pkg.id));
  }

  private async distTagSet(
    name: string,
    tag: string,
    req: Request,
    ctx: RepoContext,
  ): Promise<Response> {
    name = parseNpmName(name);
    const pkg = await this.findPackage(ctx, name);
    if (!pkg) return Response.json({ error: "Not found" }, { status: 404 });
    tag = parseRegistryInput(NpmDistTagSchema, tag, {
      code: "TAG_INVALID",
      message: "invalid dist-tag",
    });
    const version = (await req.text()).replace(/^"|"$/g, "").trim();
    parseNpmVersion(version);
    const versionId = await this.versionId(ctx, pkg.id, version);
    if (!versionId) return Response.json({ error: "version not found" }, { status: 404 });
    await setDistTag(ctx, pkg.id, tag, versionId);
    if (tag === "latest") {
      await ctx.db.update(packages).set({ latestVersion: version }).where(eq(packages.id, pkg.id));
    }
    return Response.json({ ok: true });
  }

  private async distTagDelete(name: string, tag: string, ctx: RepoContext): Promise<Response> {
    name = parseNpmName(name);
    const pkg = await this.findPackage(ctx, name);
    if (!pkg) return Response.json({ error: "Not found" }, { status: 404 });
    tag = parseRegistryInput(NpmDistTagSchema, tag, {
      code: "TAG_INVALID",
      message: "invalid dist-tag",
    });
    await ctx.db
      .delete(versionTags)
      .where(and(eq(versionTags.packageId, pkg.id), eq(versionTags.tag, tag)));
    if (tag === "latest") {
      await ctx.db.update(packages).set({ latestVersion: null }).where(eq(packages.id, pkg.id));
    }
    return Response.json({ ok: true });
  }

  /** Pull-through: mirror an upstream package (all versions) into this proxy repo. */
  async proxyIngest(pkgName: string, upstreamBase: string, ctx: RepoContext): Promise<boolean> {
    if (!isValidLegacyNpmName(pkgName)) return false;
    const upstreamHost = npmUpstreamHost(upstreamBase);
    if (!upstreamHost) return false;
    const url = npmUpstreamPackumentUrl(upstreamBase, pkgName);
    // safeFetch rejects private/loopback/metadata hosts and re-validates redirects.
    const res = await safeFetch(url, { headers: { accept: "application/json" } }).catch(() => null);
    if (!res?.ok) return false;
    const packument = await responseJson<NpmUpstreamPackument>(
      res,
      Math.min(env.REGISTRY_MAX_UPLOAD_BYTES, 10 * 1024 * 1024),
    );
    if (!packument) return false;
    const scope = pkgName.startsWith("@") ? (pkgName.split("/")[0] ?? null) : null;
    let pkg = await this.findPackage(ctx, pkgName);
    for (const [ver, manifestRaw] of Object.entries(packument.versions ?? {})) {
      if (!isValidNpmVersion(ver)) continue;
      const proxyManifest = normalizeNpmProxyManifest(pkgName, ver, manifestRaw);
      if (!proxyManifest) continue;
      let { manifest } = proxyManifest;
      const { tarballUrl, upstreamDist } = proxyManifest;
      const [existingVersion] = pkg
        ? await ctx.db
            .select({ metadata: packageVersions.metadata })
            .from(packageVersions)
            .where(
              and(
                eq(packageVersions.packageId, pkg.id),
                eq(packageVersions.version, ver),
                isNull(packageVersions.deletedAt),
              ),
            )
            .limit(1)
        : [];
      const existingDist = (existingVersion?.metadata as { dist?: NpmDist } | undefined)?.dist;
      if (pkg && existingDist && upstreamDistMatchesStored(upstreamDist, existingDist)) {
        manifest = rewriteNpmProxyManifestForExistingDist({
          manifest,
          upstreamDist,
          existingDist,
          baseUrl: ctx.baseUrl,
          mountPath: ctx.repo.mountPath,
          packageName: pkgName,
        });
        // Refresh metadata without re-downloading or re-scanning unchanged bytes.
        await upsertPackageVersion(ctx, {
          packageId: pkg.id,
          version: ver,
          metadata: { manifest, dist: existingDist },
          sizeBytes: existingDist.size,
        });
        continue;
      }
      // Only mirror tarballs served by the configured upstream host — the URL
      // comes from untrusted upstream JSON and must not point elsewhere (SSRF).
      let tRes: Response | null = null;
      try {
        if (!isNpmTarballUrlOnUpstreamHost(tarballUrl, upstreamHost)) continue;
        tRes = await safeFetch(tarballUrl, { allowedHosts: [upstreamHost] });
      } catch {
        continue;
      }
      if (!tRes.ok) continue;
      const tarball = await responseBytes(tRes, env.REGISTRY_MAX_UPLOAD_BYTES);
      if (!tarball) continue;
      if (!upstreamDistMatchesBytes(upstreamDist, tarball)) continue;
      pkg ??= await findOrCreatePackage({
        orgId: ctx.repo.orgId,
        repositoryId: ctx.repo.id,
        name: pkgName,
        namespace: scope,
      });
      const previousDigest = existingDist?.blobDigest;
      const { manifestDist, dist } = buildNpmMirroredDist({
        packageName: pkgName,
        version: ver,
        upstreamDist,
        tarball,
        baseUrl: ctx.baseUrl,
        mountPath: ctx.repo.mountPath,
      });
      manifest.dist = manifestDist;
      const { stored } = await upsertPackageVersionWithBlobRef(ctx, {
        packageId: pkg.id,
        version: ver,
        metadata: {
          manifest,
          dist,
        },
        sizeBytes: tarball.length,
        blob: {
          data: tarball,
          kind: "npm_tarball",
          scope: `${pkgName}@${ver}`,
          mediaType: "application/octet-stream",
          previousDigest,
        },
      });
      if (stored.digest !== dist.blobDigest) throw new Error("stored npm tarball digest mismatch");
      await ctx.enqueueScan({
        digest: stored.digest,
        name: pkgName,
        version: ver,
        mediaType: "application/octet-stream",
      });
    }
    if (!pkg) return false;
    const desiredTags = new Map<string, { version: string; versionId: string }>();
    for (const [tag, ver] of Object.entries(packument["dist-tags"] ?? {})) {
      if (!isValidDistTag(tag) || typeof ver !== "string") continue;
      const vid = await this.versionId(ctx, pkg.id, ver);
      if (vid) desiredTags.set(tag, { version: ver, versionId: vid });
    }
    const currentTags = await this.distTags(ctx, pkg.id);
    for (const tag of Object.keys(currentTags)) {
      if (desiredTags.has(tag)) continue;
      await ctx.db
        .delete(versionTags)
        .where(and(eq(versionTags.packageId, pkg.id), eq(versionTags.tag, tag)));
    }
    for (const [tag, { versionId }] of desiredTags) {
      await setDistTag(ctx, pkg.id, tag, versionId);
    }
    await ctx.db
      .update(packages)
      .set({ latestVersion: desiredTags.get("latest")?.version ?? null })
      .where(eq(packages.id, pkg.id));
    return true;
  }

  private async searchHandler(req: Request, ctx: RepoContext): Promise<Response> {
    const { text, from, size } = parseNpmSearchQuery(req.url);
    const where = and(
      eq(packages.repositoryId, ctx.repo.id),
      text ? like(packages.name, `%${text}%`) : sql`true`,
    );
    const totalRows = await ctx.db.select({ value: count() }).from(packages).where(where);
    const rows = await ctx.db.select().from(packages).where(where).limit(size).offset(from);

    const objects: NpmSearchObject[] = [];
    for (const p of rows) {
      const versions = await ctx.db
        .select()
        .from(packageVersions)
        .where(and(eq(packageVersions.packageId, p.id), isNull(packageVersions.deletedAt)))
        .orderBy(desc(packageVersions.createdAt), desc(packageVersions.id));
      if (versions.length === 0) continue;

      const tags = await this.distTags(ctx, p.id);
      const version = tags.latest ?? versions[0]!.version;
      const selected = versions.find((v) => v.version === version) ?? versions[0]!;
      objects.push(
        buildNpmSearchObject({
          packageName: p.name,
          selected,
          baseUrl: ctx.baseUrl,
          mountPath: ctx.repo.mountPath,
        }),
      );
    }

    return Response.json(buildNpmSearchResponse({ objects, total: totalRows[0]?.value ?? 0 }));
  }
}
