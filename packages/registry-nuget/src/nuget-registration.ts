import type { NugetVersionMeta } from "./nuget-validation";

export interface NugetRegistrationVersion {
  version: string;
  metadata: NugetVersionMeta;
}

export function buildNugetRegistrationItem(input: {
  id: string;
  version: string;
  metadata: NugetVersionMeta;
  base: string;
}) {
  const lower = input.id.toLowerCase();
  const displayId = input.metadata.displayId ?? input.id;
  const leaf = `${input.base}/v3/registrations/${lower}/${input.version}.json`;
  const content = `${input.base}/v3-flatcontainer/${lower}/${input.version}/${lower}.${input.version}.nupkg`;
  const dependencyGroups = (input.metadata.dependencyGroups ?? []).map((group) => ({
    ...(group.targetFramework ? { targetFramework: group.targetFramework } : {}),
    dependencies: group.dependencies.map((dep) => ({
      id: dep.id,
      range: dep.range,
      registration: `${input.base}/v3/registrations/${dep.id.toLowerCase()}/index.json`,
    })),
  }));
  return {
    "@id": leaf,
    "@type": "Package",
    catalogEntry: {
      "@id": leaf,
      "@type": "PackageDetails",
      id: displayId,
      version: input.version,
      listed: input.metadata.listed !== false,
      packageContent: content,
      ...(dependencyGroups.length > 0 ? { dependencyGroups } : {}),
    },
    packageContent: content,
    registrationLeafUrl: leaf,
    registration: `${input.base}/v3/registrations/${lower}/index.json`,
  };
}

export function buildNugetRegistrationIndex(input: {
  id: string;
  base: string;
  versions: NugetRegistrationVersion[];
}) {
  const lower = input.id.toLowerCase();
  const registrationUrl = `${input.base}/v3/registrations/${lower}/index.json`;
  const items = input.versions.map((version) =>
    buildNugetRegistrationItem({
      id: input.id,
      version: version.version,
      metadata: version.metadata,
      base: input.base,
    }),
  );
  const pages =
    input.versions.length === 0
      ? []
      : [
          {
            "@id": registrationUrl,
            count: items.length,
            lower: input.versions[0]?.version,
            upper: input.versions[input.versions.length - 1]?.version,
            items,
          },
        ];
  return { count: pages.length, items: pages };
}
