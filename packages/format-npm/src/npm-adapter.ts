import { env } from "@hootifactory/config";
import {
  createPackageVersion,
  Errors,
  type FormatAdapter,
  type FormatMetadata,
  findOrCreatePackage,
  type HttpMethod,
  isArtifactBlocked,
  type Permission,
  parseRegistryInput,
  type RepoContext,
  type RouteEntry,
  type RouteMatch,
  releaseBlobRef,
  safeFetch,
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
import { computeDigest } from "@hootifactory/storage";
import { decodeBase64, ifNoneMatch, responseBytes, responseJson } from "./npm-http";
import {
  type NpmDist,
  type PublishVersion,
  sha1hex,
  sha1hexText,
  sha512b64,
  upstreamDistMatchesBytes,
  upstreamDistMatchesStored,
} from "./npm-integrity";
import {
  basename,
  isValidDistTag,
  isValidLegacyNpmName,
  isValidNpmVersion,
  NpmDistTagSchema,
  NpmLegacyPackageNameSchema,
  NpmPackageNameSchema,
  NpmPublishBodySchema,
  NpmSearchQuerySchema,
  NpmTarballFilenameSchema,
  NpmVersionSchema,
  packagePath,
} from "./npm-validation";
import { buildPackument } from "./packument";

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

  authChallenge() {
    return { header: 'Basic realm="hootifactory"', status: 401 as const };
  }

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
    const [pkg] = await ctx.db
      .select()
      .from(packages)
      .where(and(eq(packages.repositoryId, ctx.repo.id), eq(packages.name, name)))
      .limit(1);
    return pkg ?? null;
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
    name = parseRegistryInput(NpmLegacyPackageNameSchema, name, {
      code: "NAME_INVALID",
      message: "invalid package name",
    });
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
    const decoder = new TextDecoder();
    const docs = parts
      .map((part) => {
        const body = typeof part.body === "string" ? part.body : decoder.decode(part.body);
        try {
          return JSON.parse(body) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((doc): doc is Record<string, unknown> => doc != null);
    const first = docs[0] ?? {};
    const versions: Record<string, unknown> = {};
    const distTags: Record<string, unknown> = {};
    const time: Record<string, unknown> = {};
    for (const doc of docs) {
      for (const [version, manifest] of Object.entries(
        (doc.versions as Record<string, unknown> | undefined) ?? {},
      )) {
        if (!Object.hasOwn(versions, version)) versions[version] = manifest;
      }
      for (const [tag, version] of Object.entries(
        (doc["dist-tags"] as Record<string, unknown> | undefined) ?? {},
      )) {
        if (!Object.hasOwn(distTags, tag)) distTags[tag] = version;
      }
      for (const [key, value] of Object.entries(
        (doc.time as Record<string, unknown> | undefined) ?? {},
      )) {
        if (!Object.hasOwn(time, key)) time[key] = value;
      }
    }
    return {
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({
        ...first,
        "dist-tags": distTags,
        versions,
        time,
      }),
    };
  }

  private async packument(name: string, req: Request, ctx: RepoContext): Promise<Response> {
    name = parseRegistryInput(NpmLegacyPackageNameSchema, name, {
      code: "NAME_INVALID",
      message: "invalid package name",
    });
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
    name = parseRegistryInput(NpmLegacyPackageNameSchema, name, {
      code: "NAME_INVALID",
      message: "invalid package name",
    });
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
    if (await isArtifactBlocked(ctx, dist.blobDigest)) {
      return Response.json({ error: "artifact blocked by scan policy" }, { status: 403 });
    }
    const etag = `"${dist.shasum}"`;
    if (ifNoneMatch(req, etag)) return new Response(null, { status: 304, headers: { etag } });
    return new Response(ctx.blobs.get(dist.blobDigest), {
      headers: { "content-type": "application/octet-stream", etag },
    });
  }

  private async publish(name: string, req: Request, ctx: RepoContext): Promise<Response> {
    const rawBody = await req.json().catch(() => null);
    const body = parseRegistryInput(NpmPublishBodySchema, rawBody, {
      code: "MANIFEST_INVALID",
      message: "invalid publish payload",
    });
    name = parseRegistryInput(NpmPackageNameSchema, name, {
      code: "NAME_INVALID",
      message: "invalid package name",
    });
    if (body.name && body.name !== name) {
      return Response.json({ error: "package name in body does not match URL" }, { status: 400 });
    }

    const attachments = body._attachments ?? {};
    const versions = body.versions ?? {};
    const metadataOnly = Object.keys(attachments).length === 0;
    if (metadataOnly) {
      return this.updateMetadataOnly(name, versions, body["dist-tags"] ?? {}, ctx);
    }
    const base = basename(name);
    const publishVersions: PublishVersion[] = [];
    for (const [ver, manifestRaw] of Object.entries(versions)) {
      parseRegistryInput(NpmVersionSchema, ver, {
        code: "MANIFEST_INVALID",
        message: "invalid package version",
      });
      const manifest = { ...(manifestRaw as Record<string, unknown>) };
      if (manifest.name !== undefined && manifest.name !== name) {
        return Response.json(
          { error: "version manifest name does not match URL" },
          { status: 400 },
        );
      }
      if (manifest.version !== undefined && manifest.version !== ver) {
        return Response.json(
          { error: "version manifest version does not match version key" },
          { status: 400 },
        );
      }
      manifest.name = name;
      manifest.version = ver;
      const attKey =
        [`${name}-${ver}.tgz`, `${base}-${ver}.tgz`].find((k) => attachments[k]) ?? undefined;
      if (!attKey) {
        return Response.json({ error: `missing tarball attachment for ${ver}` }, { status: 400 });
      }
      const tarball = decodeBase64(attachments[attKey]?.data);
      if (!tarball) {
        return Response.json({ error: `invalid tarball attachment for ${ver}` }, { status: 400 });
      }
      publishVersions.push({ version: ver, manifest, tarball });
    }
    if (!publishVersions.length) {
      return Response.json({ error: "publish payload must include a version" }, { status: 400 });
    }

    const distTags = { ...(body["dist-tags"] ?? {}) };
    if (body["dist-tags"] === undefined && publishVersions.length === 1) {
      distTags.latest = publishVersions[0]!.version;
    }
    const publishVersionSet = new Set(publishVersions.map((v) => v.version));
    const existingPkg = await this.findPackage(ctx, name);
    const existingTagVersionIds = new Map<string, string>();
    for (const [tag, ver] of Object.entries(distTags)) {
      parseRegistryInput(NpmDistTagSchema, tag, {
        code: "TAG_INVALID",
        message: "invalid dist-tag",
      });
      parseRegistryInput(NpmVersionSchema, ver, {
        code: "MANIFEST_INVALID",
        message: `dist-tag ${tag} points to an invalid version`,
      });
      if (!publishVersionSet.has(ver)) {
        const existingVersionId = existingPkg
          ? await this.versionId(ctx, existingPkg.id, ver)
          : null;
        if (!existingVersionId) {
          return Response.json(
            { error: `dist-tag ${tag} points to an unknown version` },
            { status: 400 },
          );
        }
        existingTagVersionIds.set(ver, existingVersionId);
      }
    }

    const scope = name.startsWith("@") ? (name.split("/")[0] ?? null) : null;
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
      const versionId = await createPackageVersion(ctx, {
        packageId: pkg.id,
        version: ver,
        metadata: { manifest, dist },
        sizeBytes: tarball.length,
      });
      if (!versionId) {
        if (stored.refCreated) {
          await releaseBlobRef(ctx, {
            digest: stored.digest,
            kind: "npm_tarball",
            scope: `${name}@${ver}`,
          });
        }
        return Response.json(
          { error: `cannot publish over the previously published version ${ver}` },
          { status: 403 },
        );
      }
      versionIds.set(ver, versionId);
      await ctx.enqueueScan({
        digest: stored.digest,
        name,
        version: ver,
        mediaType: "application/octet-stream",
      });
    }

    for (const [tag, ver] of Object.entries(distTags)) {
      const versionId = versionIds.get(ver) ?? existingTagVersionIds.get(ver);
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
    const [row] = await ctx.db
      .select({ id: packageVersions.id })
      .from(packageVersions)
      .where(
        and(
          eq(packageVersions.packageId, packageId),
          eq(packageVersions.version, version),
          isNull(packageVersions.deletedAt),
        ),
      )
      .limit(1);
    return row?.id;
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
      parseRegistryInput(NpmVersionSchema, ver, {
        code: "MANIFEST_INVALID",
        message: "invalid package version",
      });
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
    name = parseRegistryInput(NpmLegacyPackageNameSchema, name, {
      code: "NAME_INVALID",
      message: "invalid package name",
    });
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
    name = parseRegistryInput(NpmLegacyPackageNameSchema, name, {
      code: "NAME_INVALID",
      message: "invalid package name",
    });
    const pkg = await this.findPackage(ctx, name);
    if (!pkg) return Response.json({ error: "Not found" }, { status: 404 });
    tag = parseRegistryInput(NpmDistTagSchema, tag, {
      code: "TAG_INVALID",
      message: "invalid dist-tag",
    });
    const version = (await req.text()).replace(/^"|"$/g, "").trim();
    parseRegistryInput(NpmVersionSchema, version, {
      code: "MANIFEST_INVALID",
      message: "invalid package version",
    });
    const versionId = await this.versionId(ctx, pkg.id, version);
    if (!versionId) return Response.json({ error: "version not found" }, { status: 404 });
    await setDistTag(ctx, pkg.id, tag, versionId);
    if (tag === "latest") {
      await ctx.db.update(packages).set({ latestVersion: version }).where(eq(packages.id, pkg.id));
    }
    return Response.json({ ok: true });
  }

  private async distTagDelete(name: string, tag: string, ctx: RepoContext): Promise<Response> {
    name = parseRegistryInput(NpmLegacyPackageNameSchema, name, {
      code: "NAME_INVALID",
      message: "invalid package name",
    });
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
    let upstreamHost = "";
    try {
      upstreamHost = new URL(upstreamBase).host;
    } catch {
      return false;
    }
    const url = `${upstreamBase.replace(/\/$/, "")}/${packagePath(pkgName)}`;
    // safeFetch rejects private/loopback/metadata hosts and re-validates redirects.
    const res = await safeFetch(url, { headers: { accept: "application/json" } }).catch(() => null);
    if (!res?.ok) return false;
    const packument = await responseJson<{
      versions?: Record<string, Record<string, unknown>>;
      "dist-tags"?: Record<string, string>;
    }>(res, Math.min(env.REGISTRY_MAX_UPLOAD_BYTES, 10 * 1024 * 1024));
    if (!packument) return false;
    const scope = pkgName.startsWith("@") ? (pkgName.split("/")[0] ?? null) : null;
    let pkg = await this.findPackage(ctx, pkgName);
    const base = basename(pkgName);
    for (const [ver, manifestRaw] of Object.entries(packument.versions ?? {})) {
      if (!isValidNpmVersion(ver)) continue;
      const manifest = { ...manifestRaw } as Record<string, unknown>;
      if (manifest.name !== undefined && manifest.name !== pkgName) continue;
      if (manifest.version !== undefined && manifest.version !== ver) continue;
      manifest.name = pkgName;
      manifest.version = ver;
      const dist0 = manifest.dist as { integrity?: string; shasum?: string; tarball?: string };
      const tarballUrl = dist0?.tarball;
      if (!tarballUrl) continue;
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
      if (pkg && existingDist && upstreamDistMatchesStored(dist0, existingDist)) {
        manifest.dist = {
          ...(dist0 ?? {}),
          tarball: `${ctx.baseUrl}/${ctx.repo.mountPath}/${packagePath(pkgName)}/-/${existingDist.filename}`,
          shasum: existingDist.shasum,
          integrity: existingDist.integrity,
        };
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
        if (new URL(tarballUrl).host !== upstreamHost) continue;
        tRes = await safeFetch(tarballUrl, { allowedHosts: [upstreamHost] });
      } catch {
        continue;
      }
      if (!tRes.ok) continue;
      const tarball = await responseBytes(tRes, env.REGISTRY_MAX_UPLOAD_BYTES);
      if (!tarball) continue;
      if (!upstreamDistMatchesBytes(dist0, tarball)) continue;
      pkg ??= await findOrCreatePackage({
        orgId: ctx.repo.orgId,
        repositoryId: ctx.repo.id,
        name: pkgName,
        namespace: scope,
      });
      const previousDigest = existingDist?.blobDigest;
      const shasum = sha1hex(tarball);
      const integrity = `sha512-${sha512b64(tarball)}`;
      const filename = `${base}-${ver}.tgz`;
      manifest.dist = {
        ...(dist0 ?? {}),
        tarball: `${ctx.baseUrl}/${ctx.repo.mountPath}/${packagePath(pkgName)}/-/${filename}`,
        shasum,
        integrity,
      };
      const dist: NpmDist = {
        filename,
        blobDigest: computeDigest(tarball),
        shasum,
        integrity,
        size: tarball.length,
      };
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
    const url = new URL(req.url);
    const { text, from, size } = parseRegistryInput(
      NpmSearchQuerySchema,
      {
        text: url.searchParams.get("text") ?? undefined,
        from: url.searchParams.get("from") ?? undefined,
        size: url.searchParams.get("size") ?? undefined,
      },
      { code: "PAGINATION_NUMBER_INVALID", message: "invalid search query" },
    );
    const where = and(
      eq(packages.repositoryId, ctx.repo.id),
      text ? like(packages.name, `%${text}%`) : sql`true`,
    );
    const totalRows = await ctx.db.select({ value: count() }).from(packages).where(where);
    const rows = await ctx.db.select().from(packages).where(where).limit(size).offset(from);

    const objects: Record<string, unknown>[] = [];
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
      const manifest =
        (selected.metadata as { manifest?: Record<string, unknown> } | undefined)?.manifest ?? {};
      objects.push({
        package: {
          name: p.name,
          version: selected.version,
          description: typeof manifest.description === "string" ? manifest.description : "",
          keywords: Array.isArray(manifest.keywords) ? manifest.keywords : [],
          date: selected.createdAt.toISOString(),
          links: { npm: `${ctx.baseUrl}/${ctx.repo.mountPath}/${packagePath(p.name)}` },
          publisher: { username: "hootifactory", email: "" },
          maintainers: [{ username: "hootifactory", email: "" }],
        },
        score: { final: 1, detail: { quality: 1, popularity: 1, maintenance: 1 } },
        searchScore: 1,
      });
    }

    return Response.json({
      objects,
      total: totalRows[0]?.value ?? 0,
      time: new Date().toISOString(),
    });
  }
}
