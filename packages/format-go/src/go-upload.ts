import { parseRegistryInput } from "@hootifactory/core";
import {
  decodeBang,
  GoUploadFieldsSchema,
  type GoVersionMeta,
  GoVersionSchema,
} from "./go-validation";
import { decodeModuleDirective, readZipEntryText, validateGoModuleZip } from "./go-zip";

type GoUploadMetadata = Omit<GoVersionMeta, "zipDigest">;

export interface GoUploadPlan {
  version: string;
  mod: string;
  zipBytes: Uint8Array;
  scope: string;
  metadata: GoUploadMetadata;
}

export interface GoUploadError {
  body: { error: string };
  status: 400;
}

export async function parseGoUploadRequest(
  moduleName: string,
  versionRaw: string,
  req: Request,
): Promise<GoUploadPlan> {
  const version = parseRegistryInput(GoVersionSchema, decodeBang(versionRaw), {
    code: "MANIFEST_INVALID",
    message: "version must be a canonical Go semver (e.g. v1.2.3)",
  });
  const form = await req.formData();
  const modField = form.get("mod");
  const rawMod =
    typeof modField === "string"
      ? modField
      : modField instanceof File
        ? await modField.text()
        : `module ${moduleName}\n`;
  const fields = parseRegistryInput(
    GoUploadFieldsSchema,
    { mod: rawMod, zip: form.get("zip") },
    { code: "MANIFEST_INVALID", message: "invalid Go upload form" },
  );
  const zipBytes = new Uint8Array(await fields.zip.arrayBuffer());
  const scope = `${moduleName}@${version}.zip`;
  return {
    version,
    mod: fields.mod,
    zipBytes,
    scope,
    metadata: {
      mod: fields.mod,
      zipSize: zipBytes.length,
      time: new Date().toISOString(),
    },
  };
}

export function validateGoUploadPlan(moduleName: string, plan: GoUploadPlan): GoUploadError | null {
  const { mod, version, zipBytes } = plan;
  const zipError = validateGoModuleZip(zipBytes, moduleName, version);
  if (zipError) {
    return {
      body: { error: `invalid module zip: ${zipError}` },
      status: 400,
    };
  }

  const zipMod = readZipEntryText(zipBytes, `${moduleName}@${version}/go.mod`);
  const declaredModule = decodeModuleDirective(mod);
  const zipModule = zipMod ? decodeModuleDirective(zipMod) : null;
  if (declaredModule !== moduleName || zipModule !== moduleName) {
    return {
      body: { error: "go.mod module path does not match upload URL" },
      status: 400,
    };
  }
  return null;
}
