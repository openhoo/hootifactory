import { patternMatches } from "@hootifactory/auth";

export interface TokenScopeRepository {
  name: string;
  mountPath: string;
}

export function scopeMayTargetRepo(pattern: string, repo: TokenScopeRepository): boolean {
  if (patternMatches(pattern, repo.name)) return true;
  const ociPrefix = repo.mountPath.startsWith("v2/") ? repo.mountPath.slice(3) : null;
  if (!ociPrefix) return false;
  if (patternMatches(pattern, ociPrefix) || pattern.startsWith(`${ociPrefix}/`)) return true;
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return prefix.startsWith(`${ociPrefix}/`) || ociPrefix.startsWith(prefix);
  }
  return false;
}
