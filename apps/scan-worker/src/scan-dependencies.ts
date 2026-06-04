import { JsonRecordSchema, z } from "@hootifactory/core";
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

const NonEmptyStringSchema = z.string().min(1);
const NpmManifestSchema = z.looseObject({
  dependencies: z.unknown().optional(),
  devDependencies: z.unknown().optional(),
});
const NpmMetadataSchema = z.looseObject({
  manifest: z.unknown().optional(),
});
const CargoDependencySchema = z.looseObject({
  name: NonEmptyStringSchema,
  req: NonEmptyStringSchema,
});
const CargoMetadataSchema = z.looseObject({
  index: z
    .looseObject({
      deps: z.array(z.unknown()).optional(),
    })
    .optional(),
});
const NugetDependencySchema = z.looseObject({
  id: NonEmptyStringSchema,
  range: NonEmptyStringSchema,
});
const NugetDependencyGroupSchema = z.looseObject({
  dependencies: z.array(z.unknown()).optional(),
});
const NugetMetadataSchema = z.looseObject({
  dependencyGroups: z.array(z.unknown()).optional(),
});
const GoMetadataSchema = z.looseObject({
  mod: NonEmptyStringSchema.optional(),
});

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

  const parsed = JsonRecordSchema.safeParse(version?.metadata);
  return parsed.success ? parsed.data : {};
}

function defaultOsvEcosystem(_format: string): string {
  return "npm";
}

function npmDependencies(metadata: Record<string, unknown>): Record<string, string> {
  const parsedMetadata = NpmMetadataSchema.safeParse(metadata);
  const parsedManifest = NpmManifestSchema.safeParse(
    parsedMetadata.success ? parsedMetadata.data.manifest : undefined,
  );
  const manifest = parsedManifest.success ? parsedManifest.data : {};
  return {
    ...stringRecord(manifest.dependencies),
    ...stringRecord(manifest.devDependencies),
  };
}

function cargoDependencies(metadata: Record<string, unknown>): Record<string, string> {
  const parsed = CargoMetadataSchema.safeParse(metadata);
  const deps = parsed.success ? (parsed.data.index?.deps ?? []) : [];
  const entries: [string, string][] = [];
  for (const dep of deps) {
    const item = CargoDependencySchema.safeParse(dep);
    if (item.success) entries.push([item.data.name, item.data.req]);
  }
  return Object.fromEntries(entries);
}

function nugetDependencies(metadata: Record<string, unknown>): Record<string, string> {
  const parsed = NugetMetadataSchema.safeParse(metadata);
  const groups = parsed.success ? (parsed.data.dependencyGroups ?? []) : [];
  const entries: [string, string][] = [];
  for (const group of groups) {
    const parsedGroup = NugetDependencyGroupSchema.safeParse(group);
    const dependencies = parsedGroup.success ? (parsedGroup.data.dependencies ?? []) : [];
    for (const dependency of dependencies) {
      const item = NugetDependencySchema.safeParse(dependency);
      if (item.success) entries.push([item.data.id, item.data.range]);
    }
  }
  return Object.fromEntries(entries);
}

function goDependencies(metadata: Record<string, unknown>): Record<string, string> {
  const parsed = GoMetadataSchema.safeParse(metadata);
  const mod = parsed.success ? (parsed.data.mod ?? "") : "";
  const entries: [string, string][] = [];
  for (const match of mod.matchAll(/^\s*require\s+([^\s]+)\s+([^\s]+)\s*$/gm)) {
    const [, name, version] = match;
    if (name && version) entries.push([name, version]);
  }
  return Object.fromEntries(entries);
}

function stringRecord(value: unknown): Record<string, string> {
  const parsed = JsonRecordSchema.safeParse(value);
  if (!parsed.success) return {};
  return Object.fromEntries(
    Object.entries(parsed.data).flatMap(([key, item]) =>
      typeof item === "string" ? [[key, item]] : [],
    ),
  );
}
