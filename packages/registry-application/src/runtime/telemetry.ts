export function isReadMethod(method: string): method is "GET" | "HEAD" {
  return method === "GET" || method === "HEAD";
}

export function repoSpanAttributes(repo: {
  id: string;
  name: string;
  kind: string;
}): Record<string, string> {
  return {
    "registry.repository.id": repo.id,
    "registry.repository.name": repo.name,
    "registry.repository.kind": repo.kind,
  };
}

export function repoModuleSpanAttributes(
  moduleSource: { id: string },
  repo: { id: string; name: string; kind: string },
  handlerId?: string,
): Record<string, string> {
  return {
    "registry.module.id": moduleSource.id,
    ...repoSpanAttributes(repo),
    ...(handlerId !== undefined ? { "registry.handler": handlerId } : {}),
  };
}
