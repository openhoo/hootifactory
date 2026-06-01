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

/** Cargo sparse-index path sharding for a crate name. */
export function cargoIndexPath(name: string): string {
  const n = name.toLowerCase();
  if (n.length === 1) return `1/${n}`;
  if (n.length === 2) return `2/${n}`;
  if (n.length === 3) return `3/${n[0]}/${n}`;
  return `${n.slice(0, 2)}/${n.slice(2, 4)}/${n}`;
}

function sha256hex(bytes: Uint8Array): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(bytes);
  return h.digest("hex");
}

interface CargoVersionMeta {
  index: Record<string, unknown>;
  crateDigest: string;
}

/** Cargo sparse registry: config.json, sharded index, publish + download. */
export class CargoAdapter implements FormatAdapter {
  readonly format = "cargo" as const;
  readonly capabilities = {
    contentAddressable: false,
    resumableUploads: false,
    proxyable: true,
    virtualizable: true,
  };

  routes(): RouteEntry[] {
    return [
      { method: "GET", pattern: "/config.json", handlerId: "config" },
      { method: "PUT", pattern: "/api/v1/crates/new", handlerId: "publish" },
      { method: "GET", pattern: "/api/v1/crates/:crate/:version/download", handlerId: "download" },
      { method: "DELETE", pattern: "/api/v1/crates/:crate/:version/yank", handlerId: "yank" },
      { method: "PUT", pattern: "/api/v1/crates/:crate/:version/unyank", handlerId: "unyank" },
      { method: "GET", pattern: "/:path+", handlerId: "index" },
    ];
  }

  requiredPermission(method: HttpMethod): Permission {
    return { action: method === "GET" || method === "HEAD" ? "read" : "write" };
  }

  authChallenge() {
    return { header: 'Bearer realm="hootifactory"', status: 401 as const };
  }

  async handle(match: RouteMatch, req: Request, ctx: RepoContext): Promise<Response> {
    switch (match.entry.handlerId) {
      case "config":
        return Response.json({
          dl: `${ctx.baseUrl}/${ctx.repo.mountPath}/api/v1/crates`,
          api: `${ctx.baseUrl}/${ctx.repo.mountPath}`,
        });
      case "publish":
        return this.publish(req, ctx);
      case "download":
        return this.download(match.params.crate ?? "", match.params.version ?? "", ctx);
      case "yank":
        return this.setYank(match.params.crate ?? "", match.params.version ?? "", true, ctx);
      case "unyank":
        return this.setYank(match.params.crate ?? "", match.params.version ?? "", false, ctx);
      case "index":
        return this.index(match.params.path ?? "", ctx);
      default:
        throw Errors.notFound();
    }
  }

  private async findCrate(ctx: RepoContext, name: string) {
    const [pkg] = await ctx.db
      .select()
      .from(packages)
      .where(and(eq(packages.repositoryId, ctx.repo.id), eq(packages.name, name.toLowerCase())))
      .limit(1);
    return pkg ?? null;
  }

  private async index(path: string, ctx: RepoContext): Promise<Response> {
    const name = (path.split("/").pop() ?? "").toLowerCase();
    // The request path must equal the canonical sparse-index shard for the crate.
    if (path !== cargoIndexPath(name)) return new Response("", { status: 404 });
    const pkg = await this.findCrate(ctx, name);
    if (!pkg) return new Response("", { status: 404 });
    const vers = await ctx.db
      .select({ metadata: packageVersions.metadata })
      .from(packageVersions)
      .where(and(eq(packageVersions.packageId, pkg.id), isNull(packageVersions.deletedAt)))
      .orderBy(asc(packageVersions.createdAt));
    const lines = vers
      .map((v) => JSON.stringify((v.metadata as unknown as CargoVersionMeta).index))
      .join("\n");
    return new Response(`${lines}\n`, { headers: { "content-type": "text/plain" } });
  }

  private async download(crate: string, version: string, ctx: RepoContext): Promise<Response> {
    const pkg = await this.findCrate(ctx, crate);
    if (!pkg) throw Errors.notFound();
    const [v] = await ctx.db
      .select({ metadata: packageVersions.metadata })
      .from(packageVersions)
      .where(
        and(
          eq(packageVersions.packageId, pkg.id),
          eq(packageVersions.version, version),
          isNull(packageVersions.deletedAt),
        ),
      )
      .limit(1);
    const digest = (v?.metadata as unknown as CargoVersionMeta | undefined)?.crateDigest;
    if (!digest || !(await ctx.blobs.exists(digest))) throw Errors.notFound();
    if (await isArtifactBlocked(ctx, digest)) {
      return new Response("blocked by scan policy", { status: 403 });
    }
    return new Response(ctx.blobs.get(digest), {
      headers: { "content-type": "application/octet-stream" },
    });
  }

  /** Toggle the yanked flag in a crate version's stored index entry. */
  private async setYank(
    crate: string,
    version: string,
    yanked: boolean,
    ctx: RepoContext,
  ): Promise<Response> {
    const pkg = await this.findCrate(ctx, crate);
    if (!pkg) throw Errors.notFound();
    const [v] = await ctx.db
      .select({ id: packageVersions.id, metadata: packageVersions.metadata })
      .from(packageVersions)
      .where(
        and(
          eq(packageVersions.packageId, pkg.id),
          eq(packageVersions.version, version),
          isNull(packageVersions.deletedAt),
        ),
      )
      .limit(1);
    if (!v) throw Errors.notFound();
    const meta = (v.metadata ?? {}) as { index?: Record<string, unknown> };
    await ctx.db
      .update(packageVersions)
      .set({ metadata: { ...meta, index: { ...(meta.index ?? {}), yanked } } })
      .where(eq(packageVersions.id, v.id));
    return Response.json({ ok: true });
  }

  private async publish(req: Request, ctx: RepoContext): Promise<Response> {
    const buf = new Uint8Array(await req.arrayBuffer());
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    // Length-prefixed framing: u32 jsonLen | json | u32 crateLen | crate. Every
    // read is bounds-checked so a truncated/oversized body yields a 400, not a
    // silent truncation, wrong checksum, or a 500.
    if (buf.byteLength < 4) throw Errors.manifestInvalid({ reason: "truncated publish header" });
    let off = 0;
    const jsonLen = dv.getUint32(off, true);
    off += 4;
    if (off + jsonLen + 4 > buf.byteLength) {
      throw Errors.manifestInvalid({ reason: "truncated publish metadata" });
    }
    const meta = JSON.parse(new TextDecoder().decode(buf.subarray(off, off + jsonLen))) as {
      name: string;
      vers: string;
      deps?: {
        name: string;
        version_req: string;
        features?: string[];
        optional?: boolean;
        default_features?: boolean;
        target?: string | null;
        kind?: string;
        registry?: string | null;
        explicit_name_in_toml?: string;
      }[];
      features?: Record<string, string[]>;
    };
    off += jsonLen;
    const crateLen = dv.getUint32(off, true);
    off += 4;
    if (off + crateLen !== buf.byteLength) {
      throw Errors.manifestInvalid({ reason: "crate length does not match body" });
    }
    const crateBytes = buf.subarray(off, off + crateLen);

    const name = meta.name.toLowerCase();
    const cksum = sha256hex(crateBytes);
    const pkg = await findOrCreatePackage({
      orgId: ctx.repo.orgId,
      repositoryId: ctx.repo.id,
      name,
    });
    const [existing] = await ctx.db
      .select({ id: packageVersions.id })
      .from(packageVersions)
      .where(
        and(
          eq(packageVersions.packageId, pkg.id),
          eq(packageVersions.version, meta.vers),
          isNull(packageVersions.deletedAt),
        ),
      )
      .limit(1);
    if (existing) return Response.json({ error: "version already exists" }, { status: 409 });

    const stored = await storeBlobWithRef(ctx, {
      data: crateBytes,
      kind: "generic_file",
      scope: `${name}@${meta.vers}.crate`,
      mediaType: "application/octet-stream",
    });
    const indexEntry = {
      name: meta.name,
      vers: meta.vers,
      deps: (meta.deps ?? []).map((d) => {
        // Renamed deps: in the index, `name` is the name used in Cargo.toml and
        // `package` is the real crate name (the publish payload uses the inverse).
        const renamed = d.explicit_name_in_toml && d.explicit_name_in_toml !== d.name;
        return {
          name: renamed ? d.explicit_name_in_toml : d.name,
          req: d.version_req,
          features: d.features ?? [],
          optional: Boolean(d.optional),
          default_features: d.default_features !== false,
          target: d.target ?? null,
          kind: d.kind ?? "normal",
          registry: d.registry ?? null,
          package: renamed ? d.name : null,
        };
      }),
      cksum,
      features: meta.features ?? {},
      yanked: false,
    };
    await upsertPackageVersion(ctx, {
      packageId: pkg.id,
      version: meta.vers,
      metadata: { index: indexEntry, crateDigest: stored.digest },
      sizeBytes: crateBytes.length,
    });
    await ctx.enqueueScan({
      digest: stored.digest,
      name,
      version: meta.vers,
      mediaType: "application/octet-stream",
    });
    return Response.json({ warnings: { invalid_categories: [], invalid_badges: [], other: [] } });
  }
}
