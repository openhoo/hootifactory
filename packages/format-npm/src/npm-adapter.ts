import {
  Errors,
  type FormatAdapter,
  findOrCreatePackage,
  type HttpMethod,
  isArtifactBlocked,
  type Permission,
  type RepoContext,
  type RouteEntry,
  type RouteMatch,
  setDistTag,
  storeBlobWithRef,
  upsertPackageVersion,
} from "@hootifactory/core";
import { and, eq, like, packages, packageVersions, sql, versionTags } from "@hootifactory/db";
import { buildPackument } from "./packument";

function sha1hex(data: Uint8Array): string {
  const h = new Bun.CryptoHasher("sha1");
  h.update(data);
  return h.digest("hex");
}
function sha512b64(data: Uint8Array): string {
  const h = new Bun.CryptoHasher("sha512");
  h.update(data);
  return h.digest("base64");
}
function basename(name: string): string {
  const i = name.lastIndexOf("/");
  return i >= 0 ? name.slice(i + 1) : name;
}

interface NpmDist {
  filename: string;
  blobDigest: string;
  shasum: string;
  integrity: string;
  size: number;
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
      { method: "GET", pattern: "/-/package/:pkg+/dist-tags", handlerId: "distTagsList" },
      { method: "PUT", pattern: "/-/package/:pkg+/dist-tags/:tag", handlerId: "distTagSet" },
      { method: "GET", pattern: "/:pkg+/-/:filename", handlerId: "tarball" },
      { method: "PUT", pattern: "/:pkg+", handlerId: "publish" },
      { method: "GET", pattern: "/:pkg+", handlerId: "packument" },
    ];
  }

  requiredPermission(method: HttpMethod): Permission {
    return { action: method === "GET" || method === "HEAD" ? "read" : "write" };
  }

  authChallenge() {
    return { header: 'Basic realm="hootifactory"', status: 401 as const };
  }

  async handle(match: RouteMatch, req: Request, ctx: RepoContext): Promise<Response> {
    switch (match.entry.handlerId) {
      case "ping":
        return Response.json({});
      case "whoami":
        return Response.json({ username: ctx.principal.kind === "user" ? "user" : "token" });
      case "search":
        return this.searchHandler(req, ctx);
      case "packument":
        return this.packument(match.params.pkg ?? "", ctx);
      case "tarball":
        return this.tarball(match.params.pkg ?? "", match.params.filename ?? "", ctx);
      case "publish":
        return this.publish(match.params.pkg ?? "", req, ctx);
      case "distTagsList":
        return this.distTagsList(match.params.pkg ?? "", ctx);
      case "distTagSet":
        return this.distTagSet(match.params.pkg ?? "", match.params.tag ?? "", req, ctx);
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
    return ctx.db.select().from(packageVersions).where(eq(packageVersions.packageId, packageId));
  }

  private async distTags(ctx: RepoContext, packageId: string): Promise<Record<string, string>> {
    const rows = await ctx.db
      .select({ tag: versionTags.tag, version: packageVersions.version })
      .from(versionTags)
      .innerJoin(packageVersions, eq(versionTags.versionId, packageVersions.id))
      .where(eq(versionTags.packageId, packageId));
    const out: Record<string, string> = {};
    for (const r of rows) out[r.tag] = r.version;
    return out;
  }

  private async packument(name: string, ctx: RepoContext): Promise<Response> {
    const pkg = await this.findPackage(ctx, name);
    if (!pkg) return Response.json({ error: "Not found" }, { status: 404 });
    const versions = await this.liveVersions(ctx, pkg.id);
    const tags = await this.distTags(ctx, pkg.id);
    return Response.json(buildPackument(name, versions, tags));
  }

  private async tarball(name: string, filename: string, ctx: RepoContext): Promise<Response> {
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
    return new Response(ctx.blobs.get(dist.blobDigest), {
      headers: { "content-type": "application/octet-stream", etag: `"${dist.shasum}"` },
    });
  }

  private async publish(name: string, req: Request, ctx: RepoContext): Promise<Response> {
    const body = (await req.json().catch(() => null)) as {
      versions?: Record<string, Record<string, unknown>>;
      _attachments?: Record<string, { data: string }>;
      "dist-tags"?: Record<string, string>;
    } | null;
    if (!body) return Response.json({ error: "invalid publish payload" }, { status: 400 });

    const scope = name.startsWith("@") ? (name.split("/")[0] ?? null) : null;
    const pkg = await findOrCreatePackage({
      orgId: ctx.repo.orgId,
      repositoryId: ctx.repo.id,
      name,
      namespace: scope,
    });

    const attachments = body._attachments ?? {};
    const versions = body.versions ?? {};
    const base = basename(name);
    const versionIds = new Map<string, string>();

    for (const [ver, manifestRaw] of Object.entries(versions)) {
      const manifest = { ...(manifestRaw as Record<string, unknown>) };
      const attKey =
        [`${name}-${ver}.tgz`, `${base}-${ver}.tgz`].find((k) => attachments[k]) ?? undefined;
      if (!attKey) continue;
      const tarball = Buffer.from(attachments[attKey]!.data, "base64");
      const shasum = sha1hex(tarball);
      const integrity = `sha512-${sha512b64(tarball)}`;
      const filename = `${base}-${ver}.tgz`;
      const stored = await storeBlobWithRef(ctx, {
        data: tarball,
        kind: "npm_tarball",
        scope: `${name}@${ver}`,
        mediaType: "application/octet-stream",
      });
      const tarballUrl = `${ctx.baseUrl}/${ctx.repo.mountPath}/${name}/-/${filename}`;
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
      const versionId = await upsertPackageVersion(ctx, {
        packageId: pkg.id,
        version: ver,
        metadata: { manifest, dist },
        sizeBytes: tarball.length,
      });
      versionIds.set(ver, versionId);
      await ctx.enqueueScan({
        digest: stored.digest,
        name,
        version: ver,
        mediaType: "application/octet-stream",
      });
    }

    const distTags = body["dist-tags"] ?? {};
    for (const [tag, ver] of Object.entries(distTags)) {
      const versionId = versionIds.get(ver) ?? (await this.versionId(ctx, pkg.id, ver));
      if (versionId) await setDistTag(ctx, pkg.id, tag, versionId);
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
      .where(and(eq(packageVersions.packageId, packageId), eq(packageVersions.version, version)))
      .limit(1);
    return row?.id;
  }

  private async distTagsList(name: string, ctx: RepoContext): Promise<Response> {
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
    const pkg = await this.findPackage(ctx, name);
    if (!pkg) return Response.json({ error: "Not found" }, { status: 404 });
    const version = (await req.text()).replace(/^"|"$/g, "").trim();
    const versionId = await this.versionId(ctx, pkg.id, version);
    if (!versionId) return Response.json({ error: "version not found" }, { status: 404 });
    await setDistTag(ctx, pkg.id, tag, versionId);
    return Response.json({ ok: true });
  }

  /** Pull-through: mirror an upstream package (all versions) into this proxy repo. */
  async proxyIngest(pkgName: string, upstreamBase: string, ctx: RepoContext): Promise<boolean> {
    const url = `${upstreamBase.replace(/\/$/, "")}/${pkgName.replace("/", "%2f")}`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return false;
    const packument = (await res.json()) as {
      versions?: Record<string, Record<string, unknown>>;
      "dist-tags"?: Record<string, string>;
    };
    const scope = pkgName.startsWith("@") ? (pkgName.split("/")[0] ?? null) : null;
    const pkg = await findOrCreatePackage({
      orgId: ctx.repo.orgId,
      repositoryId: ctx.repo.id,
      name: pkgName,
      namespace: scope,
    });
    const base = basename(pkgName);
    for (const [ver, manifestRaw] of Object.entries(packument.versions ?? {})) {
      const manifest = { ...manifestRaw } as Record<string, unknown>;
      const dist0 = manifest.dist as { tarball?: string } | undefined;
      const tarballUrl = dist0?.tarball;
      if (!tarballUrl) continue;
      const tRes = await fetch(tarballUrl);
      if (!tRes.ok) continue;
      const tarball = new Uint8Array(await tRes.arrayBuffer());
      const shasum = sha1hex(tarball);
      const integrity = `sha512-${sha512b64(tarball)}`;
      const filename = `${base}-${ver}.tgz`;
      const stored = await storeBlobWithRef(ctx, {
        data: tarball,
        kind: "npm_tarball",
        scope: `${pkgName}@${ver}`,
        mediaType: "application/octet-stream",
      });
      manifest.dist = {
        ...(dist0 ?? {}),
        tarball: `${ctx.baseUrl}/${ctx.repo.mountPath}/${pkgName}/-/${filename}`,
        shasum,
        integrity,
      };
      await upsertPackageVersion(ctx, {
        packageId: pkg.id,
        version: ver,
        metadata: {
          manifest,
          dist: { filename, blobDigest: stored.digest, shasum, integrity, size: tarball.length },
        },
        sizeBytes: tarball.length,
      });
    }
    for (const [tag, ver] of Object.entries(packument["dist-tags"] ?? {})) {
      const vid = await this.versionId(ctx, pkg.id, ver);
      if (vid) await setDistTag(ctx, pkg.id, tag, vid);
    }
    return true;
  }

  private async searchHandler(req: Request, ctx: RepoContext): Promise<Response> {
    const url = new URL(req.url);
    const text = url.searchParams.get("text") ?? "";
    const size = Math.min(Number(url.searchParams.get("size") ?? 20), 100);
    const rows = await ctx.db
      .select()
      .from(packages)
      .where(
        and(
          eq(packages.repositoryId, ctx.repo.id),
          text ? like(packages.name, `%${text}%`) : sql`true`,
        ),
      )
      .limit(size);
    const objects = rows.map((p) => ({
      package: { name: p.name, version: p.latestVersion ?? "0.0.0", description: "" },
      score: { final: 1, detail: { quality: 1, popularity: 1, maintenance: 1 } },
      searchScore: 1,
    }));
    return Response.json({ objects, total: objects.length, time: new Date().toISOString() });
  }
}
