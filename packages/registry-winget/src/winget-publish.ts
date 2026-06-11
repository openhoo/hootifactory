import { parseRegistryInput } from "@hootifactory/registry";
import {
  WingetFilenameSchema,
  WingetPublishManifestSchema,
  type WingetVersionMeta,
} from "./winget-validation";

export interface WingetPublishPlan {
  packageIdentifier: string;
  version: string;
  filename: string;
  installerBytes: Uint8Array;
  /** Metadata minus the digest fields, which the lifecycle fills from the stored blob. */
  metadata: Omit<WingetVersionMeta, "installerDigest" | "installerSha256">;
}

export interface WingetPublishError {
  error: string;
  status: 400;
}

export type WingetPublishPlanResult =
  | { ok: true; plan: WingetPublishPlan }
  | { ok: false; error: WingetPublishError };

const DEFAULT_FILENAME = "installer.bin";

/** Strip any directory components a client put in the upload filename. */
function sanitizeFilename(name: string | undefined): string {
  if (!name) return DEFAULT_FILENAME;
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_");
  if (!cleaned || cleaned.startsWith(".")) return DEFAULT_FILENAME;
  const candidate = cleaned.slice(0, 256);
  return WingetFilenameSchema.safeParse(candidate).success ? candidate : DEFAULT_FILENAME;
}

/**
 * Parse the `PUT /api/packageManifests/:packageIdentifier` publish body
 * (HOOTIFACTORY EXTENSION — the public winget REST API is read-only). It is a
 * multipart/form-data body with a `manifest` JSON part and an `installer`
 * binary part.
 */
export async function parseWingetPublishRequest(
  packageIdentifier: string,
  req: Request,
): Promise<WingetPublishPlanResult> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return {
      ok: false,
      error: { error: "expected multipart/form-data publish body", status: 400 },
    };
  }

  const form = await req.formData().catch(() => null);
  if (!form) {
    return { ok: false, error: { error: "invalid multipart/form-data body", status: 400 } };
  }

  const manifestField = form.get("manifest");
  const rawManifest =
    typeof manifestField === "string"
      ? manifestField
      : manifestField instanceof File
        ? await manifestField.text()
        : null;
  if (rawManifest === null) {
    return { ok: false, error: { error: "missing manifest part", status: 400 } };
  }

  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(rawManifest);
  } catch {
    return { ok: false, error: { error: "manifest part is not valid JSON", status: 400 } };
  }

  const manifest = parseRegistryInput(WingetPublishManifestSchema, manifestJson, {
    code: "MANIFEST_INVALID",
    message: "invalid manifest",
  });

  // The served PackageIdentifier is reconstructed from `Publisher.PackageName`
  // in the manifest (see WingetAdapter.identifierFor). Reject a publish whose
  // body would yield an identifier different from the URL segment so the stored
  // package name, the DefaultLocale, and the read-back identifier stay consistent.
  const bodyIdentifier = `${manifest.Publisher}.${manifest.PackageName}`;
  if (bodyIdentifier.toLowerCase() !== packageIdentifier.toLowerCase()) {
    return {
      ok: false,
      error: {
        error: "PackageIdentifier must equal Publisher.PackageName from the manifest",
        status: 400,
      },
    };
  }

  const installerField = form.get("installer");
  if (!(installerField instanceof File)) {
    return { ok: false, error: { error: "missing installer part", status: 400 } };
  }
  const installerBytes = new Uint8Array(await installerField.arrayBuffer());
  if (installerBytes.length === 0) {
    return { ok: false, error: { error: "installer part is empty", status: 400 } };
  }

  const filename = sanitizeFilename(
    installerField.name || `${manifest.PackageName}-${manifest.PackageVersion}`,
  );

  return {
    ok: true,
    plan: {
      packageIdentifier,
      version: manifest.PackageVersion,
      filename,
      installerBytes,
      metadata: {
        architecture: manifest.Architecture ?? "x64",
        installerType: manifest.InstallerType ?? "exe",
        ...(manifest.Scope ? { scope: manifest.Scope } : {}),
        publisher: manifest.Publisher,
        packageName: manifest.PackageName,
        ...(manifest.ShortDescription ? { shortDescription: manifest.ShortDescription } : {}),
        ...(manifest.License ? { license: manifest.License } : {}),
        filename,
      },
    },
  };
}

/** winget renders the installer hash as uppercase hex; derive it from the bare hex. */
export function wingetUpperSha256(hex: string): string {
  return hex.toUpperCase();
}

/** Stable blob-ref scope key for an installer. */
export function wingetInstallerScope(
  packageIdentifier: string,
  version: string,
  filename: string,
): string {
  return `${packageIdentifier.toLowerCase()}@${version}/${filename}`;
}
