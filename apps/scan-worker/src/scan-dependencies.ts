import { JsonRecordSchema } from "@hootifactory/core";
import { and, db, eq, packages, packageVersions } from "@hootifactory/db";
import { withSpan } from "@hootifactory/observability";
import type { RegistryPlugin } from "@hootifactory/registry";

export interface DependencyTarget {
  repositoryId: string;
  module: RegistryPlugin;
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
  purlType?: string;
}

export async function collectPackageDependencies(
  target: DependencyTarget,
): Promise<CollectedDependencies> {
  return withSpan(
    "scan.collect_dependencies",
    { "registry.module.id": target.module.id },
    async (span) => {
      let collected: CollectedDependencies = {
        deps: {},
        osvEcosystem: target.module.scan?.defaultOsvEcosystem ?? "",
      };

      const { artifactName, artifactVersion } = target;
      if (artifactName && artifactVersion && target.module.scan?.dependencyGraph) {
        const metadata = await loadPackageVersionMetadata({
          ...target,
          artifactName,
          artifactVersion,
        });
        if (metadata) {
          const graph = target.module.scan.dependencyGraph({ metadata });
          collected = {
            deps: graph.deps,
            osvEcosystem: graph.osvEcosystem ?? target.module.scan.defaultOsvEcosystem ?? "",
            purlType: graph.purlType,
          };
        }
      }

      span.setAttribute("scan.dependencies.count", Object.keys(collected.deps).length);
      return collected;
    },
  );
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

  const parsed = JsonRecordSchema.safeParse(version?.metadata);
  return parsed.success ? parsed.data : {};
}
