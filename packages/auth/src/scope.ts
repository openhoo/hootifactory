/**
 * Repository scope pattern matching.
 *  - "*"            matches everything (org-wide)
 *  - "acme/*"       matches "acme" and anything under "acme/"
 *  - "acme*"        prefix glob
 *  - "acme/app"     exact
 */
export function patternMatches(pattern: string, name: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -2);
    return name === prefix || name.startsWith(`${prefix}/`);
  }
  if (pattern.endsWith("*")) {
    return name.startsWith(pattern.slice(0, -1));
  }
  return pattern === name;
}

export interface TokenScopeRepository {
  name: string;
  mountPath: string;
}

export function scopeMayTargetRepo(pattern: string, repo: TokenScopeRepository): boolean {
  if (patternMatches(pattern, repo.name)) return true;
  // A token scope may also target a repo by its mount-relative path (the mount
  // path with its leading mount segment removed) — e.g. a content-addressable
  // module whose clients address it by image path rather than the repo name.
  // Derived generically from the mount path so no module identity leaks here.
  const slash = repo.mountPath.indexOf("/");
  const mountRelative = slash >= 0 ? repo.mountPath.slice(slash + 1) : null;
  if (!mountRelative) return false;
  if (patternMatches(pattern, mountRelative) || pattern.startsWith(`${mountRelative}/`))
    return true;
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return prefix.startsWith(`${mountRelative}/`) || mountRelative.startsWith(prefix);
  }
  return false;
}
