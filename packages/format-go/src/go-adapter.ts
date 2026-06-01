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
  storeBlobWithRef,
  upsertPackageVersion,
} from "@hootifactory/core";
import { and, asc, eq, isNull, packages, packageVersions } from "@hootifactory/db";

interface GoVersionMeta {
  mod: string;
  zipDigest: string;
  zipSize: number;
  time: string;
}

/** Decode Go module "!"-escaping (an uppercase letter is encoded as `!` + lowercase). */
function decodeBang(s: string): string {
  return s.replace(/!([a-z])/g, (_m, c: string) => c.toUpperCase());
}

/** Canonical Go semver: vMAJOR.MINOR.PATCH with optional -prerelease / +build. */
const GO_VERSION_RE = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Split a vX.Y.Z[-pre] version into numeric parts + prerelease for comparison. */
function parseSemver(v: string): { nums: number[]; pre: string | null } | null {
  const m = v.match(/^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
}

function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return a < b ? -1 : a > b ? 1 : 0;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
  }
  // A release (no prerelease) outranks a prerelease of the same x.y.z.
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  if (pa.pre && pb.pre) return pa.pre < pb.pre ? -1 : pa.pre > pb.pre ? 1 : 0;
  return 0;
}

/** Go @latest: highest release version; only fall back to a prerelease if no release exists. */
function pickLatest(versions: string[]): string | undefined {
  if (versions.length === 0) return undefined;
  const sorted = [...versions].sort(compareSemver);
  const releases = sorted.filter((v) => !parseSemver(v)?.pre);
  return (releases.length ? releases : sorted).at(-1);
}

/** Go module proxy (GOPROXY protocol) + a custom upload endpoint for hosted modules. */
export class GoAdapter implements FormatAdapter {
  readonly format = "go" as const;
  readonly capabilities = {
    contentAddressable: false,
    resumableUploads: false,
    proxyable: true,
    virtualizable: true,
  };

  routes(): RouteEntry[] {
    return [
      { method: "GET", pattern: "/:module+/@v/list", handlerId: "list" },
      { method: "GET", pattern: "/:module+/@latest", handlerId: "latest" },
      { method: "GET", pattern: "/:module+/@v/:file", handlerId: "file" },
      { method: "PUT", pattern: "/:module+/@v/:version", handlerId: "upload" },
    ];
  }

  requiredPermission(method: HttpMethod): Permission {
    return { action: method === "GET" || method === "HEAD" ? "read" : "write" };
  }

  authChallenge() {
    return { header: 'Basic realm="hootifactory"', status: 401 as const };
  }

  async handle(match: RouteMatch, req: Request, ctx: RepoContext): Promise<Response> {
    const moduleName = decodeBang(match.params.module ?? "");
    switch (match.entry.handlerId) {
      case "list":
        return this.list(moduleName, ctx);
      case "latest":
        return this.latest(moduleName, ctx);
      case "file":
        return this.file(moduleName, match.params.file ?? "", ctx);
      case "upload":
        return this.upload(moduleName, match.params.version ?? "", req, ctx);
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

  private async versions(ctx: RepoContext, packageId: string) {
    return ctx.db
      .select({
        version: packageVersions.version,
        metadata: packageVersions.metadata,
        createdAt: packageVersions.createdAt,
      })
      .from(packageVersions)
      .where(and(eq(packageVersions.packageId, packageId), isNull(packageVersions.deletedAt)))
      .orderBy(asc(packageVersions.createdAt));
  }

  private async list(moduleName: string, ctx: RepoContext): Promise<Response> {
    // Unknown module → 404 so the client falls through the proxy chain. An empty
    // 200 would falsely assert "known module, no versions".
    const pkg = await this.findPackage(ctx, moduleName);
    if (!pkg) throw Errors.notFound();
    const rows = await this.versions(ctx, pkg.id);
    return new Response(`${rows.map((r) => r.version).join("\n")}\n`, {
      headers: { "content-type": "text/plain" },
    });
  }

  private async latest(moduleName: string, ctx: RepoContext): Promise<Response> {
    const pkg = await this.findPackage(ctx, moduleName);
    if (!pkg) throw Errors.notFound();
    const rows = await this.versions(ctx, pkg.id);
    const latestVer = pickLatest(rows.map((r) => r.version));
    const row = rows.find((r) => r.version === latestVer);
    if (!row) throw Errors.notFound();
    const meta = row.metadata as unknown as GoVersionMeta;
    return Response.json({
      Version: row.version,
      Time: meta.time ?? row.createdAt.toISOString(),
    });
  }

  private async file(moduleName: string, file: string, ctx: RepoContext): Promise<Response> {
    const pkg = await this.findPackage(ctx, moduleName);
    if (!pkg) throw Errors.notFound();
    const dot = file.lastIndexOf(".");
    if (dot < 0) throw Errors.notFound();
    const version = decodeBang(file.slice(0, dot));
    const ext = file.slice(dot + 1);
    const [row] = await ctx.db
      .select({ metadata: packageVersions.metadata, createdAt: packageVersions.createdAt })
      .from(packageVersions)
      .where(
        and(
          eq(packageVersions.packageId, pkg.id),
          eq(packageVersions.version, version),
          isNull(packageVersions.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw Errors.notFound();
    const meta = row.metadata as unknown as GoVersionMeta;

    if (ext === "info") {
      return Response.json({ Version: version, Time: meta.time ?? row.createdAt.toISOString() });
    }
    if (ext === "mod") {
      return new Response(meta.mod ?? `module ${moduleName}\n`, {
        headers: { "content-type": "text/plain" },
      });
    }
    if (ext === "zip") {
      if (await isArtifactBlocked(ctx, meta.zipDigest)) {
        return new Response("blocked by scan policy", { status: 403 });
      }
      if (!(await ctx.blobs.exists(meta.zipDigest))) throw Errors.notFound();
      return new Response(ctx.blobs.get(meta.zipDigest), {
        headers: { "content-type": "application/zip" },
      });
    }
    throw Errors.notFound();
  }

  private async upload(
    moduleName: string,
    versionRaw: string,
    req: Request,
    ctx: RepoContext,
  ): Promise<Response> {
    const version = decodeBang(versionRaw);
    if (!GO_VERSION_RE.test(version)) {
      return Response.json(
        { error: "version must be a canonical Go semver (e.g. v1.2.3)" },
        { status: 400 },
      );
    }
    const form = await req.formData();
    const modField = form.get("mod");
    const zipField = form.get("zip");
    const mod =
      typeof modField === "string"
        ? modField
        : modField instanceof File
          ? await modField.text()
          : `module ${moduleName}\n`;
    if (!(zipField instanceof File)) {
      return Response.json({ error: "missing zip" }, { status: 400 });
    }
    const zipBytes = new Uint8Array(await zipField.arrayBuffer());
    const pkg = await findOrCreatePackage({
      orgId: ctx.repo.orgId,
      repositoryId: ctx.repo.id,
      name: moduleName,
    });
    const [existing] = await ctx.db
      .select({ id: packageVersions.id })
      .from(packageVersions)
      .where(and(eq(packageVersions.packageId, pkg.id), eq(packageVersions.version, version)))
      .limit(1);
    if (existing) return Response.json({ error: "version already exists" }, { status: 409 });

    const stored = await storeBlobWithRef(ctx, {
      data: zipBytes,
      kind: "generic_file",
      scope: `${moduleName}@${version}.zip`,
      mediaType: "application/zip",
    });
    const meta: GoVersionMeta = {
      mod,
      zipDigest: stored.digest,
      zipSize: zipBytes.length,
      time: new Date().toISOString(),
    };
    await upsertPackageVersion(ctx, {
      packageId: pkg.id,
      version,
      metadata: meta as unknown as Record<string, unknown>,
      sizeBytes: zipBytes.length,
    });
    await ctx.enqueueScan({
      digest: stored.digest,
      name: moduleName,
      version,
      mediaType: "application/zip",
    });
    return Response.json({ ok: true, module: moduleName, version });
  }
}
