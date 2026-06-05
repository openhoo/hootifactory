import type { WingetVersionMeta } from "./winget-validation";

/** All winget REST success bodies are wrapped in `{ "Data": ... }`. */
export function wingetData<T>(data: T): { Data: T } {
  return { Data: data };
}

/** One entry of a winget REST error body. */
export interface WingetErrorEntry {
  ErrorCode: number;
  ErrorMessage: string;
}

/**
 * The winget REST error body is a top-level ARRAY of `{ ErrorCode, ErrorMessage }`
 * (WinGet-1.1.0.yaml), never a `Data` envelope and never a single-object shape.
 * Every error this source emits itself uses this shape for spec fidelity and
 * cross-path consistency.
 */
export function wingetError(code: number, message: string): WingetErrorEntry[] {
  return [{ ErrorCode: code, ErrorMessage: message }];
}

/** Build a winget REST error `Response` (top-level error array, given status). */
export function wingetErrorResponse(status: number, message: string): Response {
  return Response.json(wingetError(status, message), { status });
}

export const WINGET_DEFAULT_LOCALE = "en-US";

export interface WingetInstaller {
  Architecture: string;
  InstallerType: string;
  InstallerUrl: string;
  InstallerSha256: string;
  Scope?: string;
}

export interface WingetDefaultLocale {
  PackageLocale: string;
  Publisher: string;
  PackageName: string;
  ShortDescription: string;
  License?: string;
}

export interface WingetManifestVersion {
  PackageVersion: string;
  DefaultLocale: WingetDefaultLocale;
  Installers: WingetInstaller[];
}

export interface WingetPackageManifest {
  PackageIdentifier: string;
  Versions: WingetManifestVersion[];
}

export interface WingetSearchVersion {
  PackageVersion: string;
}

export interface WingetSearchResult {
  PackageIdentifier: string;
  PackageName: string;
  Publisher: string;
  Versions: WingetSearchVersion[];
}

/** Public download URL for a stored installer blob. */
export function wingetInstallerUrl(
  baseUrl: string,
  mountPath: string,
  packageIdentifier: string,
  version: string,
  filename: string,
): string {
  return `${baseUrl}/${mountPath}/api/installers/${encodeURIComponent(packageIdentifier)}/${encodeURIComponent(version)}/${encodeURIComponent(filename)}`;
}

/** Build a single manifest `Versions[]` entry from one stored version. */
export function buildWingetManifestVersion(input: {
  baseUrl: string;
  mountPath: string;
  packageIdentifier: string;
  version: string;
  metadata: WingetVersionMeta;
}): WingetManifestVersion {
  const { metadata } = input;
  const installer: WingetInstaller = {
    Architecture: metadata.architecture,
    InstallerType: metadata.installerType,
    InstallerUrl: wingetInstallerUrl(
      input.baseUrl,
      input.mountPath,
      input.packageIdentifier,
      input.version,
      metadata.filename,
    ),
    InstallerSha256: metadata.installerSha256,
    ...(metadata.scope ? { Scope: metadata.scope } : {}),
  };
  return {
    PackageVersion: input.version,
    DefaultLocale: {
      PackageLocale: WINGET_DEFAULT_LOCALE,
      Publisher: metadata.publisher,
      PackageName: metadata.packageName,
      ShortDescription: metadata.shortDescription ?? "",
      ...(metadata.license ? { License: metadata.license } : {}),
    },
    Installers: [installer],
  };
}

/** Assemble a full `packageManifests` document from stored versions. */
export function buildWingetPackageManifest(input: {
  baseUrl: string;
  mountPath: string;
  packageIdentifier: string;
  versions: Array<{ version: string; metadata: WingetVersionMeta }>;
}): WingetPackageManifest {
  return {
    PackageIdentifier: input.packageIdentifier,
    Versions: input.versions.map((entry) =>
      buildWingetManifestVersion({
        baseUrl: input.baseUrl,
        mountPath: input.mountPath,
        packageIdentifier: input.packageIdentifier,
        version: entry.version,
        metadata: entry.metadata,
      }),
    ),
  };
}

/**
 * The `Version` query parameter is the only one this source honors; `Channel`
 * and `Market` are accepted but ignored. winget clients read this sibling array
 * to decide which manifest narrowing they may request.
 */
export const WINGET_PACKAGE_MANIFEST_UNSUPPORTED_QUERY_PARAMETERS = ["Channel", "Market"] as const;

/**
 * A full `packageManifests` GET response: the `Data` envelope plus the spec's
 * optional `UnsupportedQueryParameters` / `RequiredQueryParameters` siblings
 * (WinGet-1.1.0.yaml). `RequiredQueryParameters` is empty — none are required.
 */
export function buildWingetPackageManifestResponse(document: WingetPackageManifest): {
  Data: WingetPackageManifest;
  RequiredQueryParameters: string[];
  UnsupportedQueryParameters: string[];
} {
  return {
    Data: document,
    RequiredQueryParameters: [],
    UnsupportedQueryParameters: [...WINGET_PACKAGE_MANIFEST_UNSUPPORTED_QUERY_PARAMETERS],
  };
}

/**
 * A full `manifestSearch` response: the `Data` array plus the spec's optional
 * `RequiredPackageMatchFields` / `UnsupportedPackageMatchFields` siblings
 * (WinGet-1.1.0.yaml). Both are empty — no field is required, and the source
 * tolerates (ignores) any match field it does not act on.
 */
export function buildWingetSearchResponse(results: WingetSearchResult[]): {
  Data: WingetSearchResult[];
  RequiredPackageMatchFields: string[];
  UnsupportedPackageMatchFields: string[];
} {
  return {
    Data: results,
    RequiredPackageMatchFields: [],
    UnsupportedPackageMatchFields: [],
  };
}

/** Build one `manifestSearch` result row. */
export function buildWingetSearchResult(input: {
  packageIdentifier: string;
  packageName: string;
  publisher: string;
  versions: string[];
}): WingetSearchResult {
  return {
    PackageIdentifier: input.packageIdentifier,
    PackageName: input.packageName,
    Publisher: input.publisher,
    Versions: input.versions.map((version) => ({ PackageVersion: version })),
  };
}

/**
 * winget matching over PackageIdentifier + PackageName. An empty needle matches
 * everything (a bare/`FetchAllManifests` request lists the source). `exact`
 * requires a full case-insensitive equality (honoring `MatchType: "Exact"`);
 * otherwise the needle is a case-insensitive substring of any haystack.
 */
export function wingetMatches(
  needle: string,
  haystacks: string[],
  options: { exact?: boolean } = {},
): boolean {
  if (!needle) return true;
  const lowered = needle.toLowerCase();
  if (options.exact) {
    return haystacks.some((value) => value.toLowerCase() === lowered);
  }
  return haystacks.some((value) => value.toLowerCase().includes(lowered));
}
