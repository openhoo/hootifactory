import type { RegistryScanProvider } from "./adapter";

export interface RegistryScanInput {
  defaultOsvEcosystem?: string;
  purlType?: string;
  dependencies?: (metadata: Record<string, unknown>) => Record<string, string>;
  dependencyGraph?: RegistryScanProvider["dependencyGraph"];
  contentAddressableManifestGraph?: RegistryScanProvider["contentAddressableManifestGraph"];
  referencedDigestPaths?: readonly string[];
  referencedDigests?: RegistryScanProvider["referencedDigests"];
}

export interface RegistryScanDsl {
  defaultOsvEcosystem(value: string): RegistryScanDsl;
  osvEcosystem(value: string): RegistryScanDsl;
  purlType(value: string): RegistryScanDsl;
  dependencies(handler: NonNullable<RegistryScanInput["dependencies"]>): RegistryScanDsl;
  dependencyGraph(handler: NonNullable<RegistryScanInput["dependencyGraph"]>): RegistryScanDsl;
  contentAddressableManifestGraph(
    graph: NonNullable<RegistryScanInput["contentAddressableManifestGraph"]>,
  ): RegistryScanDsl;
  referencedDigestPaths(...paths: string[]): RegistryScanDsl;
  referencedDigests(handler: NonNullable<RegistryScanInput["referencedDigests"]>): RegistryScanDsl;
}

export function createRegistryScanDsl(input: RegistryScanInput): RegistryScanDsl {
  const dsl: RegistryScanDsl = {
    defaultOsvEcosystem: (value) => {
      input.defaultOsvEcosystem = value;
      return dsl;
    },
    osvEcosystem: (value) => dsl.defaultOsvEcosystem(value),
    purlType: (value) => {
      input.purlType = value;
      return dsl;
    },
    dependencies: (handler) => {
      input.dependencies = handler;
      return dsl;
    },
    dependencyGraph: (handler) => {
      input.dependencyGraph = handler;
      return dsl;
    },
    contentAddressableManifestGraph: (graph) => {
      input.contentAddressableManifestGraph = graph;
      return dsl;
    },
    referencedDigestPaths: (...paths) => {
      input.referencedDigestPaths = [...(input.referencedDigestPaths ?? []), ...paths];
      return dsl;
    },
    referencedDigests: (handler) => {
      input.referencedDigests = handler;
      return dsl;
    },
  };
  return dsl;
}

function valueAtPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (current === null || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}

export function registryScan(input: RegistryScanInput): RegistryScanProvider {
  return {
    ...(input.defaultOsvEcosystem !== undefined
      ? { defaultOsvEcosystem: input.defaultOsvEcosystem }
      : {}),
    ...(input.dependencyGraph
      ? { dependencyGraph: input.dependencyGraph }
      : input.dependencies
        ? {
            dependencyGraph: ({ metadata }) => ({
              deps: input.dependencies?.(metadata) ?? {},
              ...(input.defaultOsvEcosystem !== undefined
                ? { osvEcosystem: input.defaultOsvEcosystem }
                : {}),
              ...(input.purlType !== undefined ? { purlType: input.purlType } : {}),
            }),
          }
        : {}),
    ...(input.contentAddressableManifestGraph
      ? { contentAddressableManifestGraph: input.contentAddressableManifestGraph }
      : {}),
    ...(input.referencedDigestPaths || input.referencedDigests
      ? {
          referencedDigests: (metadata) => {
            const direct = input.referencedDigests?.(metadata) ?? [];
            const byPath = (input.referencedDigestPaths ?? []).flatMap((path) => {
              const value = valueAtPath(metadata, path);
              if (typeof value === "string") return [value];
              if (Array.isArray(value))
                return value.filter((item): item is string => typeof item === "string");
              return [];
            });
            return [...new Set([...direct, ...byPath])];
          },
        }
      : {}),
  };
}
