import { parseRegistryInput } from "@hootifactory/registry";
import {
  filenameVersionMatches,
  PypiFilenameSchema,
  PypiUploadFieldsSchema,
  parsePypiFilename,
} from "./pypi-validation";
import { normalizeName } from "./simple";

export type PypiUploadError = {
  body: { error: string } | { message: string };
  status: 400;
};

export interface PypiUploadPlan {
  rawName: string;
  name: string;
  version: string;
  filename: string;
  content: File;
  size: number;
  expectedDigest?: string;
  requiresPython?: string;
  filetype?: string;
}

export type PypiUploadPlanResult =
  | { ok: true; plan: PypiUploadPlan }
  | { ok: false; error: PypiUploadError };

export async function parsePypiUploadRequest(req: Request): Promise<PypiUploadPlanResult> {
  const form = await req.formData();
  const content = form.get("content");
  if (!(content instanceof File)) {
    return { ok: false, error: { body: { error: "missing file content" }, status: 400 } };
  }

  const fields = parseRegistryInput(
    PypiUploadFieldsSchema,
    {
      name: form.get("name"),
      version: form.get("version"),
      sha256_digest: form.get("sha256_digest") || undefined,
      requires_python: form.get("requires_python") || undefined,
      filetype: form.get("filetype") || undefined,
    },
    { code: "MANIFEST_INVALID", message: "invalid upload metadata" },
  );

  const rawName = fields.name;
  const name = normalizeName(rawName);
  const version = fields.version;
  const filename = parseRegistryInput(PypiFilenameSchema, content.name, {
    code: "NAME_INVALID",
    message: "invalid distribution filename",
  });
  const filenameIdentity = parsePypiFilename(filename);
  if (
    !filenameIdentity ||
    normalizeName(filenameIdentity.name) !== name ||
    !filenameVersionMatches(version, filenameIdentity.version)
  ) {
    return {
      ok: false,
      error: {
        body: { message: "filename does not match submitted package name and version" },
        status: 400,
      },
    };
  }

  return {
    ok: true,
    plan: {
      rawName,
      name,
      version,
      filename,
      content,
      size: content.size,
      expectedDigest: fields.sha256_digest
        ? `sha256:${fields.sha256_digest.toLowerCase()}`
        : undefined,
      requiresPython: fields.requires_python,
      filetype: fields.filetype,
    },
  };
}
