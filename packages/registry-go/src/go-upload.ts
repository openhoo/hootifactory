import { parseRegistryInput } from "@hootifactory/registry";
import {
  decodeBang,
  GoUploadFieldsSchema,
  type GoVersionMeta,
  GoVersionSchema,
  modulePathMajor,
  parseSemver,
} from "./go-validation";
import { decodeModuleDirective, validateGoModuleZipResult } from "./go-zip";

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
  const zipResult = validateGoModuleZipResult(zipBytes, moduleName, version);
  if (!zipResult.ok) {
    return {
      body: { error: `invalid module zip: ${zipResult.error}` },
      status: 400,
    };
  }

  const declaredModule = decodeModuleDirective(mod);
  const zipModule = decodeModuleDirective(zipResult.goMod);
  if (declaredModule !== moduleName || zipModule !== moduleName) {
    return {
      body: { error: "go.mod module path does not match upload URL" },
      status: 400,
    };
  }

  const pathMajor = modulePathMajor(moduleName);
  const verMajor = parseSemver(version)?.nums[0];
  if (verMajor != null) {
    if (pathMajor != null ? verMajor !== pathMajor : verMajor >= 2) {
      return {
        body: { error: "version major does not match module path major suffix" },
        status: 400,
      };
    }
  }
  return null;
}
