import { and, db, eq, packages, packageVersions } from "@hootifactory/db";
import { withSpan } from "@hootifactory/observability";

export interface DependencyTarget {
  repositoryId: string;
  repositoryFormat: string;
  artifactName: string | null;
  artifactVersion: string | null;
}

type VersionedDependencyTarget = DependencyTarget & {
  artifactName: string;
  artifactVersion: string;
};

export interface CollectedDependencies {
  deps: Record<string, string>;
  osvEcosystem: string;
}

export async function collectPackageDependencies(
  target: DependencyTarget,
): Promise<CollectedDependencies> {
  return withSpan(
    "scan.collect_dependencies",
    { "registry.format": target.repositoryFormat },
    async (span) => {
      let collected: CollectedDependencies = {
        deps: {},
        osvEcosystem: defaultOsvEcosystem(target.repositoryFormat),
      };

      const { artifactName, artifactVersion } = target;
      if (artifactName && artifactVersion) {
        const metadata = await loadPackageVersionMetadata({
          ...target,
          artifactName,
          artifactVersion,
        });
        if (metadata) {
          collected = dependenciesFromMetadata(target.repositoryFormat, metadata);
        }
      }

      span.setAttribute("scan.dependencies.count", Object.keys(collected.deps).length);
      return collected;
    },
  );
}

export function dependenciesFromMetadata(
  format: string,
  metadata: Record<string, unknown>,
): CollectedDependencies {
  switch (format) {
    case "npm":
      return {
        deps: npmDependencies(metadata),
        osvEcosystem: "npm",
      };
    case "cargo":
      return {
        deps: cargoDependencies(metadata),
        osvEcosystem: "crates.io",
      };
    case "nuget":
      return {
        deps: nugetDependencies(metadata),
        osvEcosystem: "NuGet",
      };
    case "go":
      return {
        deps: goDependencies(metadata),
        osvEcosystem: "Go",
      };
    default:
      return {
        deps: {},
        osvEcosystem: defaultOsvEcosystem(format),
      };
  }
}

async function loadPackageVersionMetadata(
  target: VersionedDependencyTarget,
): Promise<Record<string, unknown> | null> {
  const [pkg] = await db
    .select({ id: packages.id })
    .from(packages)
    .where(
      and(eq(packages.repositoryId, target.repositoryId), eq(packages.name, target.artifactName)),
    )
    .limit(1);
  if (!pkg) return null;

  const [version] = await db
    .select({ metadata: packageVersions.metadata })
    .from(packageVersions)
    .where(
      and(
        eq(packageVersions.packageId, pkg.id),
        eq(packageVersions.version, target.artifactVersion),
      ),
    )
    .limit(1);

  return asRecord(version?.metadata) ?? {};
}

function defaultOsvEcosystem(_format: string): string {
  return "npm";
}

function npmDependencies(metadata: Record<string, unknown>): Record<string, string> {
  const manifest = asRecord(metadata.manifest);
  return {
    ...stringRecord(manifest?.dependencies),
    ...stringRecord(manifest?.devDependencies),
  };
}

function cargoDependencies(metadata: Record<string, unknown>): Record<string, string> {
  const index = asRecord(metadata.index);
  const deps = Array.isArray(index?.deps) ? index.deps : [];
  const entries: [string, string][] = [];
  for (const dep of deps) {
    const item = asRecord(dep);
    if (typeof item?.name === "string" && typeof item.req === "string") {
      entries.push([item.name, item.req]);
    }
  }
  return Object.fromEntries(entries);
}

function nugetDependencies(metadata: Record<string, unknown>): Record<string, string> {
  const groups = Array.isArray(metadata.dependencyGroups) ? metadata.dependencyGroups : [];
  const entries: [string, string][] = [];
  for (const group of groups) {
    const dependencies = asRecord(group)?.dependencies;
    if (!Array.isArray(dependencies)) continue;
    for (const dependency of dependencies) {
      const item = asRecord(dependency);
      if (typeof item?.id === "string" && typeof item.range === "string") {
        entries.push([item.id, item.range]);
      }
    }
  }
  return Object.fromEntries(entries);
}

function goDependencies(metadata: Record<string, unknown>): Record<string, string> {
  const mod = typeof metadata.mod === "string" ? metadata.mod : "";
  const entries: [string, string][] = [];
  for (const match of mod.matchAll(/^\s*require\s+([^\s]+)\s+([^\s]+)\s*$/gm)) {
    const [, name, version] = match;
    if (name && version) entries.push([name, version]);
  }
  return Object.fromEntries(entries);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const entries: [string, string][] = [];
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") entries.push([key, item]);
  }
  return Object.fromEntries(entries);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
