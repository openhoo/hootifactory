import { digestHex, type RegistryRequestContext } from "@hootifactory/registry";
import {
  createPackageVersion,
  findOrCreatePackage,
  findVersion,
  listRepositoryVersionMetadata,
  patchPackageVersion,
  releaseBlobRef,
  storeBlobWithRef,
} from "@hootifactory/registry-application";
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

  const pkg = await findOrCreatePackage({
    orgId: ctx.repo.orgId,
    repositoryId: ctx.repo.id,
    name,
  });
  const existing = await findVersion(pkg.id, version);
  if (existing?.deletedAt) {
    return Response.json({ message: "Release version already exists." }, { status: 409 });
  }

  const stored = await storeBlobWithRef(ctx, {
    data: bytes,
    kind: "pypi_file",
    scope: filename,
    mediaType: "application/octet-stream",
  });
  const fileMeta = buildPypiFileMetadata(parsed.plan, stored.digest);

  const added = await addFileToVersion(ctx, {
    packageId: pkg.id,
    version,
    rawName,
    requiresPython,
    fileMeta,
  });
  if (!added.ok) {
    if (stored.refCreated) {
      await releaseBlobRef(ctx, { digest: stored.digest, kind: "pypi_file", scope: filename });
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
  const rows = await listRepositoryVersionMetadata(ctx, { liveOnly: false });
  return rows.flatMap((r) => normalizePypiVersionMetadata(r.metadata).files ?? []);
}

async function addFileToVersion(
  ctx: RegistryRequestContext,
  opts: {
    packageId: string;
    version: string;
    rawName: string;
    requiresPython?: string;
    fileMeta: PypiFileMeta;
  },
): Promise<AddPypiFileResult> {
  const created = await createPackageVersion(ctx, {
    packageId: opts.packageId,
    version: opts.version,
    metadata: {
      name: opts.rawName,
      requiresPython: opts.requiresPython,
      files: [opts.fileMeta],
    },
    sizeBytes: opts.fileMeta.size,
  });
  if (created) return { ok: true, versionId: created };

  return patchPackageVersion<AddPypiFileResult>({
    packageId: opts.packageId,
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
}
