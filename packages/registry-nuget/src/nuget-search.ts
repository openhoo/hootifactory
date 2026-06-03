import { parseRegistryInput } from "@hootifactory/registry";
import {
  isPrereleaseNugetVersion,
  isSemVer2NugetVersion,
  NugetSearchQuerySchema,
  type NugetVersionMeta,
} from "./nuget-validation";

export interface NugetSearchQuery {
  q: string;
  skip: number;
  take: number;
  includePrerelease: boolean;
  includeSemVer2: boolean;
}

export interface NugetSearchVersion {
  version: string;
  metadata: NugetVersionMeta;
}

export function parseNugetSearchQuery(url: string): NugetSearchQuery {
  const searchParams = new URL(url).searchParams;
  return parseRegistryInput(
    NugetSearchQuerySchema,
    {
      q: searchParams.get("q") ?? undefined,
      skip: searchParams.get("skip") ?? undefined,
      take: searchParams.get("take") ?? undefined,
      prerelease: searchParams.get("prerelease") ?? undefined,
      semVerLevel: searchParams.get("semVerLevel") ?? undefined,
    },
    { code: "MANIFEST_INVALID", message: "invalid search query" },
  );
}

export function filterNugetSearchVersions(
  versions: NugetSearchVersion[],
  query: NugetSearchQuery,
): NugetSearchVersion[] {
  return versions.filter((version) => {
    if (!query.includePrerelease && isPrereleaseNugetVersion(version.version)) return false;
    if (
      !query.includeSemVer2 &&
      (version.metadata.semVer2 ?? isSemVer2NugetVersion(version.version))
    ) {
      return false;
    }
    return true;
  });
}

export function buildNugetSearchResult(input: {
  packageName: string;
  versions: NugetSearchVersion[];
  base: string;
}) {
  const latest = input.versions.at(-1);
  if (!latest) throw new Error("NuGet search result requires at least one version");
  const lower = input.packageName.toLowerCase();
  return {
    id: latest.metadata.displayId ?? input.packageName,
    version: latest.version,
    versions: input.versions.map((version) => ({
      version: version.version,
      downloads: 0,
      "@id": `${input.base}/v3/registrations/${lower}/${version.version}.json`,
    })),
    packageTypes: [],
    registration: `${input.base}/v3/registrations/${lower}/index.json`,
    totalDownloads: 0,
  };
}

export function buildNugetSearchResponse<T>(
  data: T[],
  query: Pick<NugetSearchQuery, "skip" | "take">,
): { totalHits: number; data: T[] } {
  return {
    totalHits: data.length,
    data: data.slice(query.skip, query.skip + query.take),
  };
}
