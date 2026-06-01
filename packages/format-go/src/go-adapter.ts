import { inflateRawSync } from "node:zlib";
import {
  createPackageVersion,
  Errors,
  type FormatAdapter,
  findOrCreatePackage,
  type HttpMethod,
  isArtifactBlocked,
  type Permission,
  parseRegistryInput,
  type RepoContext,
  type RouteEntry,
  type RouteMatch,
  releaseBlobRef,
  storeBlobWithRef,
  z,
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
const GoModuleSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.split("/").some((part) => !part || part === "." || part === ".."),
    "invalid Go module path",
  );
const GoVersionSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(GO_VERSION_RE, "version must be a canonical Go semver")
  .refine((value) => parseSemver(value) != null, "version must be a canonical Go semver");
const GoVersionFileSchema = z
  .string()
  .min(1)
  .max(300)
  .regex(/^.+\.(info|mod|zip)$/, "invalid Go version file");
const GoUploadFieldsSchema = z.strictObject({
  mod: z.string().min(1).max(1_000_000),
  zip: z.custom<File>((value) => value instanceof File, { message: "missing zip" }),
});

function validPrerelease(pre: string): boolean {
  return pre.split(".").every((part) => {
    if (!/^[0-9A-Za-z-]+$/.test(part)) return false;
    return !/^\d+$/.test(part) || /^(0|[1-9]\d*)$/.test(part);
  });
}

function comparePrerelease(a: string, b: string): number {
  const aa = a.split(".");
  const bb = b.split(".");
  const max = Math.max(aa.length, bb.length);
  for (let i = 0; i < max; i++) {
    const x = aa[i];
    const y = bb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff;
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function isPseudoVersion(v: string): boolean {
  return /^v\d+\.\d+\.\d+-(?:0\.|[0-9A-Za-z.-]+\.)?0\.\d{14}-[0-9a-f]{12}$/i.test(v);
}

/** Split a vX.Y.Z[-pre] version into numeric parts + prerelease for comparison. */
function parseSemver(v: string): { nums: number[]; pre: string | null } | null {
  const m = v.match(/^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  if (m[4] && !validPrerelease(m[4])) return null;
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
  if (pa.pre && pb.pre) return comparePrerelease(pa.pre, pb.pre);
  return 0;
}

function readU16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function decodeModuleDirective(mod: string): string | null {
  for (const line of mod.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;
    const match = /^module\s+(\S+)\s*$/.exec(trimmed);
    return match?.[1] ?? null;
  }
  return null;
}

function findZipEndOfCentralDirectory(view: DataView): number {
  const min = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= min; offset--) {
    if (readU32(view, offset) === 0x06054b50) return offset;
  }
  return -1;
}

function hasUnsafeZipPath(name: string): boolean {
  const path = name.endsWith("/") ? name.slice(0, -1) : name;
  if (!path || path.startsWith("/") || path.includes("\\")) return true;
  return path.split("/").some((part) => !part || part === "." || part === "..");
}

function validateGoModuleZip(
  bytes: Uint8Array,
  moduleName: string,
  version: string,
): string | null {
  if (bytes.byteLength < 22) return "zip payload is too short";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findZipEndOfCentralDirectory(view);
  if (eocd < 0) return "zip end of central directory not found";

  const entries = readU16(view, eocd + 10);
  const centralSize = readU32(view, eocd + 12);
  const centralOffset = readU32(view, eocd + 16);
  if (entries < 1) return "zip has no entries";
  if (centralOffset + centralSize > bytes.byteLength) return "zip central directory is truncated";

  const prefix = `${moduleName}@${version}/`;
  const decoder = new TextDecoder();
  let pos = centralOffset;
  let hasGoMod = false;
  for (let i = 0; i < entries; i++) {
    if (pos + 46 > bytes.byteLength || readU32(view, pos) !== 0x02014b50) {
      return "zip central directory entry is invalid";
    }
    const nameLen = readU16(view, pos + 28);
    const extraLen = readU16(view, pos + 30);
    const commentLen = readU16(view, pos + 32);
    const nameStart = pos + 46;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > bytes.byteLength) return "zip filename is truncated";
    const name = decoder.decode(bytes.subarray(nameStart, nameEnd));
    if (hasUnsafeZipPath(name)) return "zip contains an unsafe path";
    if (!name.startsWith(prefix)) return "zip entries must be rooted at module@version";
    if (name === `${prefix}go.mod`) hasGoMod = true;
    pos = nameEnd + extraLen + commentLen;
  }
  if (pos > centralOffset + centralSize) return "zip central directory exceeds declared size";
  if (!hasGoMod) return "zip is missing go.mod";
  return null;
}

function readZipEntryText(bytes: Uint8Array, entryName: string): string | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findZipEndOfCentralDirectory(view);
  if (eocd < 0) return null;

  const entries = readU16(view, eocd + 10);
  const centralSize = readU32(view, eocd + 12);
  const centralOffset = readU32(view, eocd + 16);
  if (centralOffset + centralSize > bytes.byteLength) return null;

  const decoder = new TextDecoder();
  let pos = centralOffset;
  for (let i = 0; i < entries; i++) {
    if (pos + 46 > bytes.byteLength || readU32(view, pos) !== 0x02014b50) return null;
    const method = readU16(view, pos + 10);
    const compressedSize = readU32(view, pos + 20);
    const nameLen = readU16(view, pos + 28);
    const extraLen = readU16(view, pos + 30);
    const commentLen = readU16(view, pos + 32);
    const localOffset = readU32(view, pos + 42);
    const nameStart = pos + 46;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > bytes.byteLength) return null;
    const name = decoder.decode(bytes.subarray(nameStart, nameEnd));
    if (name === entryName) {
      if (localOffset + 30 > bytes.byteLength || readU32(view, localOffset) !== 0x04034b50) {
        return null;
      }
      const localNameLen = readU16(view, localOffset + 26);
      const localExtraLen = readU16(view, localOffset + 28);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > bytes.byteLength) return null;
      const data = bytes.subarray(dataStart, dataEnd);
      if (method === 0) return decoder.decode(data);
      if (method === 8) {
        try {
          return decoder.decode(inflateRawSync(data));
        } catch {
          return null;
        }
      }
      return null;
    }
    pos = nameEnd + extraLen + commentLen;
  }
  return null;
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
    proxyable: false,
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
    const moduleName = parseRegistryInput(GoModuleSchema, decodeBang(match.params.module ?? ""), {
      code: "NAME_INVALID",
      message: "invalid Go module path",
    });
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
    return new Response(
      `${rows
        .map((r) => r.version)
        .filter((v) => !isPseudoVersion(v))
        .join("\n")}\n`,
      {
        headers: { "content-type": "text/plain" },
      },
    );
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
    file = parseRegistryInput(GoVersionFileSchema, file, {
      code: "NAME_INVALID",
      message: "invalid Go version file",
    });
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
    const version = parseRegistryInput(GoVersionSchema, decodeBang(versionRaw), {
      code: "MANIFEST_INVALID",
      message: "version must be a canonical Go semver (e.g. v1.2.3)",
    });
    const form = await req.formData();
    const modField = form.get("mod");
    const zipField = form.get("zip");
    const rawMod =
      typeof modField === "string"
        ? modField
        : modField instanceof File
          ? await modField.text()
          : `module ${moduleName}\n`;
    const fields = parseRegistryInput(
      GoUploadFieldsSchema,
      { mod: rawMod, zip: zipField },
      { code: "MANIFEST_INVALID", message: "invalid Go upload form" },
    );
    const mod = fields.mod;
    const zipFile = fields.zip;
    const zipBytes = new Uint8Array(await zipFile.arrayBuffer());
    const existingPkg = await this.findPackage(ctx, moduleName);
    if (existingPkg) {
      const [existing] = await ctx.db
        .select({ id: packageVersions.id })
        .from(packageVersions)
        .where(
          and(eq(packageVersions.packageId, existingPkg.id), eq(packageVersions.version, version)),
        )
        .limit(1);
      if (existing) return Response.json({ error: "version already exists" }, { status: 409 });
    }

    const zipError = validateGoModuleZip(zipBytes, moduleName, version);
    if (zipError)
      return Response.json({ error: `invalid module zip: ${zipError}` }, { status: 400 });
    const zipMod = readZipEntryText(zipBytes, `${moduleName}@${version}/go.mod`);
    const declaredModule = decodeModuleDirective(mod);
    const zipModule = zipMod ? decodeModuleDirective(zipMod) : null;
    if (declaredModule !== moduleName || zipModule !== moduleName) {
      return Response.json(
        { error: "go.mod module path does not match upload URL" },
        { status: 400 },
      );
    }
    const pkg =
      existingPkg ??
      (await findOrCreatePackage({
        orgId: ctx.repo.orgId,
        repositoryId: ctx.repo.id,
        name: moduleName,
      }));

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
    const versionId = await createPackageVersion(ctx, {
      packageId: pkg.id,
      version,
      metadata: meta as unknown as Record<string, unknown>,
      sizeBytes: zipBytes.length,
    });
    if (!versionId) {
      if (stored.refCreated) {
        await releaseBlobRef(ctx, {
          digest: stored.digest,
          kind: "generic_file",
          scope: `${moduleName}@${version}.zip`,
        });
      }
      return Response.json({ error: "version already exists" }, { status: 409 });
    }
    await ctx.enqueueScan({
      digest: stored.digest,
      name: moduleName,
      version,
      mediaType: "application/zip",
    });
    return Response.json({ ok: true, module: moduleName, version });
  }
}
