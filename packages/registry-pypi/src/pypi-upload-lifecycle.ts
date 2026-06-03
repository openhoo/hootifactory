import {
  digestHex,
  type RegistryRequestContext,
  releaseRegistryBlobRef,
  storeRegistryBlobWithRef,
} from "@hootifactory/registry";
import { type PypiUploadPlan, parsePypiUploadRequest } from "./pypi-upload";
import {
  type AddPypiFileResult,
  normalizePypiVersionMetadata,
  type PypiFileMeta,
} from "./pypi-validation";

export function buildPypiFileMetadata(
  plan: Pick<PypiUploadPlan, "bytes" | "filename" | "filetype" | "requiresPython">,
  digest: string,
): PypiFileMeta {
  return {
    filename: plan.filename,
    blobDigest: digest,
    sha256: digestHex(digest),
    requiresPython: plan.requiresPython,
    size: plan.bytes.length,
    filetype: plan.filetype,
  };
}

export function pypiScanMediaType(filetype: string | undefined): string {
  return filetype === "bdist_wheel" ? "application/zip" : "application/x-tar";
}

export async function handlePypiUpload(
  req: Request,
  ctx: RegistryRequestContext,
): Promise<Response> {
  const parsed = await parsePypiUploadRequest(req);
  if (!parsed.ok) return Response.json(parsed.error.body, { status: parsed.error.status });
  const { bytes, filename, filetype, name, rawName, requiresPython, version } = parsed.plan;

  // PyPI files are immutable: reject a re-upload of an existing filename,
  // including files hidden by retention.
  if ((await allFiles(ctx)).some((f) => f.filename === filename)) {
    return Response.json({ message: "File already exists." }, { status: 409 });
  }

  const pkg = await ctx.data.packages.findOrCreate({
    name,
  });
  const existing = await ctx.data.versions.find(pkg, version);
  if (existing?.deletedAt) {
    return Response.json({ message: "Release version already exists." }, { status: 409 });
  }

  const stored = await storeRegistryBlobWithRef(ctx, {
    data: bytes,
    kind: "pypi_file",
    scope: filename,
    mediaType: "application/octet-stream",
  });
  const fileMeta = buildPypiFileMetadata(parsed.plan, stored.digest);

  const added = await addFileToVersion(ctx, {
    package: pkg,
    version,
    rawName,
    requiresPython,
    fileMeta,
    storedDigest: stored.digest,
  });
  if (!added.ok) {
    if (stored.refCreated) {
      await releaseRegistryBlobRef(ctx, {
        digest: stored.digest,
        kind: "pypi_file",
        scope: filename,
      });
    }
    return Response.json(
      {
        message:
          added.reason === "file_exists"
            ? "File already exists."
            : "Release version already exists.",
      },
      { status: 409 },
    );
  }

  await ctx.enqueueScan({
    digest: stored.digest,
    name,
    version,
    mediaType: pypiScanMediaType(filetype),
  });

  return new Response(null, { status: 200 });
}

async function allFiles(ctx: RegistryRequestContext): Promise<PypiFileMeta[]> {
  const rows = await ctx.data.versions.listRepositoryMetadata({ liveOnly: false });
  return rows.flatMap((r) => normalizePypiVersionMetadata(r.metadata).files ?? []);
}

async function addFileToVersion(
  ctx: RegistryRequestContext,
  opts: {
    package: { id: string; orgId: string; repositoryId: string; name: string };
    version: string;
    rawName: string;
    requiresPython?: string;
    fileMeta: PypiFileMeta;
    storedDigest: string;
  },
): Promise<AddPypiFileResult> {
  const created = await ctx.data.versions.create({
    package: opts.package,
    version: opts.version,
    metadata: {
      name: opts.rawName,
      requiresPython: opts.requiresPython,
      files: [opts.fileMeta],
    },
    sizeBytes: opts.fileMeta.size,
  });
  if (created) {
    await ctx.data.assets.upsert({
      digest: opts.storedDigest,
      role: "pypi_file",
      package: opts.package,
      packageVersion: { id: created, packageId: opts.package.id, version: opts.version },
      scope: opts.fileMeta.filename,
      path: opts.fileMeta.filename,
      mediaType: "application/octet-stream",
      sizeBytes: opts.fileMeta.size,
      metadata: { filetype: opts.fileMeta.filetype },
    });
    return { ok: true, versionId: created };
  }

  const result = await ctx.data.versions.patch<AddPypiFileResult>({
    package: opts.package,
    version: opts.version,
    patch: (row) => {
      if (!row?.id || row.deletedAt) {
        return { result: { ok: false, reason: "version_exists" as const } };
      }

      const metadata = normalizePypiVersionMetadata(row.metadata);
      if ((metadata.files ?? []).some((f) => f.filename === opts.fileMeta.filename)) {
        return { result: { ok: false, reason: "file_exists" as const } };
      }

      const files = [...(metadata.files ?? []), opts.fileMeta];
      return {
        update: {
          metadata: {
            ...metadata,
            name: metadata.name ?? opts.rawName,
            requiresPython: metadata.requiresPython ?? opts.requiresPython,
            files,
          },
          sizeBytes: files.reduce((sum, file) => sum + file.size, 0),
        },
        result: { ok: true, versionId: row.id },
      };
    },
  });
  if (result.ok) {
    await ctx.data.assets.upsert({
      digest: opts.storedDigest,
      role: "pypi_file",
      package: opts.package,
      packageVersion: { id: result.versionId, packageId: opts.package.id, version: opts.version },
      scope: opts.fileMeta.filename,
      path: opts.fileMeta.filename,
      mediaType: "application/octet-stream",
      sizeBytes: opts.fileMeta.size,
      metadata: { filetype: opts.fileMeta.filetype },
    });
  }
  return result;
}
