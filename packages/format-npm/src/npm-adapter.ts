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
  desc,
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
function sha1hexText(data: string): string {
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

function packagePath(name: string): string {
  return encodeURIComponent(name);
}

/** npm package-name rules (subset): optional scope, url-safe, ≤214 chars. */
function isValidNpmName(name: string): boolean {
  if (!name || name.length > 214) return false;
  return /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name);
}

function isValidNpmVersion(version: string): boolean {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version,
    );
  if (!match) return false;
  for (const id of (match[4] ?? "").split(".").filter(Boolean)) {
    if (/^\d+$/.test(id) && !/^(0|[1-9]\d*)$/.test(id)) return false;
  }
  return true;
}

function isValidDistTag(tag: string): boolean {
  if (!tag || tag.length > 214) return false;
  if (!/^[A-Za-z][A-Za-z0-9._~-]*$/.test(tag)) return false;
  if (/^v\d/i.test(tag)) return false;
  return !isValidNpmVersion(tag);
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
  if (
    (typeof dist.integrity !== "string" || !dist.integrity.trim()) &&
    (typeof dist.shasum !== "string" || !dist.shasum.trim())
  ) {
    return false;
  }
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

interface PublishVersion {
  version: string;
  manifest: Record<string, unknown>;
  tarball: Buffer;
}

function decodeBase64(data: unknown): Buffer | null {
  if (typeof data !== "string") return null;
  const normalized = data.replace(/\s+/g, "");
  if (!normalized || normalized.length % 4 === 1) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return null;
  const decoded = Buffer.from(normalized, "base64");
  if (!decoded.length) return null;
  if (decoded.toString("base64").replace(/=+$/, "") !== normalized.replace(/=+$/, "")) {
    return null;
  }
  return decoded;
}

function boundedInt(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(Math.trunc(parsed), max));
}

function ifNoneMatch(req: Request, etag: string): boolean {
  const header = req.headers.get("if-none-match");
  if (!header) return false;
  return header
    .split(",")
    .map((v) => v.trim())
    .some((v) => v === "*" || v === etag || v === `W/${etag}`);
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

  private async packument(name: string, req: Request, ctx: RepoContext): Promise<Response> {
    if (!isValidNpmName(name))
      return Response.json({ error: "invalid package name" }, { status: 400 });
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
    if (!isValidNpmName(name))
      return Response.json({ error: "invalid package name" }, { status: 400 });
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

    const attachments = body._attachments ?? {};
    const versions = body.versions ?? {};
    const base = basename(name);
    const publishVersions: PublishVersion[] = [];
    for (const [ver, manifestRaw] of Object.entries(versions)) {
      if (!isValidNpmVersion(ver)) {
        return Response.json({ error: "invalid package version" }, { status: 400 });
      }
      if (!manifestRaw || typeof manifestRaw !== "object" || Array.isArray(manifestRaw)) {
        return Response.json({ error: "invalid version manifest" }, { status: 400 });
      }
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
      if (!isValidDistTag(tag)) {
        return Response.json({ error: "invalid dist-tag" }, { status: 400 });
      }
      if (typeof ver !== "string" || !isValidNpmVersion(ver)) {
        return Response.json(
          { error: `dist-tag ${tag} points to an invalid version` },
          { status: 400 },
        );
      }
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

  private async distTagsList(name: string, ctx: RepoContext): Promise<Response> {
    if (!isValidNpmName(name))
      return Response.json({ error: "invalid package name" }, { status: 400 });
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
    if (!isValidNpmName(name))
      return Response.json({ error: "invalid package name" }, { status: 400 });
    const pkg = await this.findPackage(ctx, name);
    if (!pkg) return Response.json({ error: "Not found" }, { status: 404 });
    if (!isValidDistTag(tag)) return Response.json({ error: "invalid dist-tag" }, { status: 400 });
    const version = (await req.text()).replace(/^"|"$/g, "").trim();
    const versionId = await this.versionId(ctx, pkg.id, version);
    if (!versionId) return Response.json({ error: "version not found" }, { status: 404 });
    await setDistTag(ctx, pkg.id, tag, versionId);
    if (tag === "latest") {
      await ctx.db.update(packages).set({ latestVersion: version }).where(eq(packages.id, pkg.id));
    }
    return Response.json({ ok: true });
  }

  private async distTagDelete(name: string, tag: string, ctx: RepoContext): Promise<Response> {
    if (!isValidNpmName(name))
      return Response.json({ error: "invalid package name" }, { status: 400 });
    const pkg = await this.findPackage(ctx, name);
    if (!pkg) return Response.json({ error: "Not found" }, { status: 404 });
    if (!isValidDistTag(tag)) return Response.json({ error: "invalid dist-tag" }, { status: 400 });
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
    if (!isValidNpmName(pkgName)) return false;
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
    const packument = (await res.json()) as {
      versions?: Record<string, Record<string, unknown>>;
      "dist-tags"?: Record<string, string>;
    };
    const scope = pkgName.startsWith("@") ? (pkgName.split("/")[0] ?? null) : null;
    let pkg: Awaited<ReturnType<typeof findOrCreatePackage>> | null = null;
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
      const tarball = new Uint8Array(await tRes.arrayBuffer());
      if (!upstreamDistMatchesBytes(dist0, tarball)) continue;
      pkg ??= await findOrCreatePackage({
        orgId: ctx.repo.orgId,
        repositoryId: ctx.repo.id,
        name: pkgName,
        namespace: scope,
      });
      const [existingVersion] = await ctx.db
        .select({ metadata: packageVersions.metadata })
        .from(packageVersions)
        .where(
          and(
            eq(packageVersions.packageId, pkg.id),
            eq(packageVersions.version, ver),
            isNull(packageVersions.deletedAt),
          ),
        )
        .limit(1);
      const previousDigest = (existingVersion?.metadata as { dist?: NpmDist } | undefined)?.dist
        ?.blobDigest;
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
        tarball: `${ctx.baseUrl}/${ctx.repo.mountPath}/${packagePath(pkgName)}/-/${filename}`,
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
      if (previousDigest && previousDigest !== stored.digest) {
        await releaseBlobRef(ctx, {
          digest: previousDigest,
          kind: "npm_tarball",
          scope: `${pkgName}@${ver}`,
        });
      }
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
    const text = url.searchParams.get("text") ?? "";
    const from = boundedInt(url.searchParams.get("from"), 0, 0, 10_000);
    const size = boundedInt(url.searchParams.get("size"), 20, 0, 100);
    const rows = await ctx.db
      .select()
      .from(packages)
      .where(
        and(
          eq(packages.repositoryId, ctx.repo.id),
          text ? like(packages.name, `%${text}%`) : sql`true`,
        ),
      )
      .limit(Math.max(from + size, 100));

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
      objects: objects.slice(from, from + size),
      total: objects.length,
      time: new Date().toISOString(),
    });
  }
}
