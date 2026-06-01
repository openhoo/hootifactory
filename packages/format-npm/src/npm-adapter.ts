import {
  createPackageVersion,
  Errors,
  type FormatAdapter,
  findOrCreatePackage,
  type HttpMethod,
  isArtifactBlocked,
  type Permission,
  type RepoContext,
  type RouteEntry,
  type RouteMatch,
  releaseBlobRef,
  safeFetch,
  setDistTag,
  storeBlobWithRef,
  upsertPackageVersion,
} from "@hootifactory/core";
import {
  and,
  eq,
  isNull,
  like,
  packages,
  packageVersions,
  sql,
  versionTags,
} from "@hootifactory/db";
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
function digestB64(algorithm: "sha1" | "sha256" | "sha384" | "sha512", data: Uint8Array): string {
  const h = new Bun.CryptoHasher(algorithm);
  h.update(data);
  return h.digest("base64");
}
function basename(name: string): string {
  const i = name.lastIndexOf("/");
  return i >= 0 ? name.slice(i + 1) : name;
}

/** npm package-name rules (subset): optional scope, url-safe, ≤214 chars. */
function isValidNpmName(name: string): boolean {
  if (!name || name.length > 214) return false;
  return /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name);
}

const INTEGRITY_ALGORITHMS = new Set(["sha1", "sha256", "sha384", "sha512"]);

function integrityTokenMatches(token: string, data: Uint8Array): boolean {
  const value = token.split("?")[0] ?? "";
  const separator = value.indexOf("-");
  if (separator <= 0) return false;
  const algorithm = value.slice(0, separator) as "sha1" | "sha256" | "sha384" | "sha512";
  const expected = value.slice(separator + 1);
  if (!INTEGRITY_ALGORITHMS.has(algorithm) || !expected) return false;
  return digestB64(algorithm, data) === expected;
}

function upstreamDistMatchesBytes(
  dist: { integrity?: string; shasum?: string },
  data: Uint8Array,
): boolean {
  if (typeof dist.integrity === "string" && dist.integrity.trim()) {
    const tokens = dist.integrity.trim().split(/\s+/);
    if (!tokens.some((token) => integrityTokenMatches(token, data))) return false;
  }
  if (typeof dist.shasum === "string" && dist.shasum.trim()) {
    if (sha1hex(data) !== dist.shasum.trim().toLowerCase()) return false;
  }
  return true;
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
      { method: "DELETE", pattern: "/-/package/:pkg+/dist-tags/:tag", handlerId: "distTagDelete" },
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
      name?: string;
      versions?: Record<string, Record<string, unknown>>;
      _attachments?: Record<string, { data: string }>;
      "dist-tags"?: Record<string, string>;
    } | null;
    if (!body) return Response.json({ error: "invalid publish payload" }, { status: 400 });
    if (!isValidNpmName(name)) {
      return Response.json({ error: "invalid package name" }, { status: 400 });
    }
    if (body.name && body.name !== name) {
      return Response.json({ error: "package name in body does not match URL" }, { status: 400 });
    }

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

    // Any version row, including a retention tombstone, reserves the npm version.
    // Retention hides bytes from readers; it must not make immutable versions
    // publishable again.
    const used = await ctx.db
      .select({ version: packageVersions.version })
      .from(packageVersions)
      .where(eq(packageVersions.packageId, pkg.id));
    const usedSet = new Set(used.map((v) => v.version));

    for (const [ver, manifestRaw] of Object.entries(versions)) {
      if (usedSet.has(ver)) {
        return Response.json(
          { error: `cannot publish over the previously published version ${ver}` },
          { status: 403 },
        );
      }
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

  private async distTagDelete(name: string, tag: string, ctx: RepoContext): Promise<Response> {
    const pkg = await this.findPackage(ctx, name);
    if (!pkg) return Response.json({ error: "Not found" }, { status: 404 });
    await ctx.db
      .delete(versionTags)
      .where(and(eq(versionTags.packageId, pkg.id), eq(versionTags.tag, tag)));
    return Response.json({ ok: true });
  }

  /** Pull-through: mirror an upstream package (all versions) into this proxy repo. */
  async proxyIngest(pkgName: string, upstreamBase: string, ctx: RepoContext): Promise<boolean> {
    let upstreamHost = "";
    try {
      upstreamHost = new URL(upstreamBase).host;
    } catch {
      return false;
    }
    const url = `${upstreamBase.replace(/\/$/, "")}/${pkgName.replace("/", "%2f")}`;
    // safeFetch rejects private/loopback/metadata hosts and re-validates redirects.
    const res = await safeFetch(url, { headers: { accept: "application/json" } }).catch(() => null);
    if (!res?.ok) return false;
    const packument = (await res.json()) as {
      versions?: Record<string, Record<string, unknown>>;
      "dist-tags"?: Record<string, string>;
    };
    const scope = pkgName.startsWith("@") ? (pkgName.split("/")[0] ?? null) : null;
    let pkg: Awaited<ReturnType<typeof findOrCreatePackage>> | null = null;
    const base = basename(pkgName);
    for (const [ver, manifestRaw] of Object.entries(packument.versions ?? {})) {
      const manifest = { ...manifestRaw } as Record<string, unknown>;
      const dist0 = manifest.dist as { integrity?: string; shasum?: string; tarball?: string };
      const tarballUrl = dist0?.tarball;
      if (!tarballUrl) continue;
      // Only mirror tarballs served by the configured upstream host — the URL
      // comes from untrusted upstream JSON and must not point elsewhere (SSRF).
      let tRes: Response | null = null;
      try {
        if (new URL(tarballUrl).host !== upstreamHost) continue;
        tRes = await safeFetch(tarballUrl);
      } catch {
        continue;
      }
      if (!tRes.ok) continue;
      const tarball = new Uint8Array(await tRes.arrayBuffer());
      if (!upstreamDistMatchesBytes(dist0, tarball)) continue;
      pkg ??= await findOrCreatePackage({
        orgId: ctx.repo.orgId,
        repositoryId: ctx.repo.id,
        name: pkgName,
        namespace: scope,
      });
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
      await ctx.enqueueScan({
        digest: stored.digest,
        name: pkgName,
        version: ver,
        mediaType: "application/octet-stream",
      });
    }
    if (!pkg) return false;
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
