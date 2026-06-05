import type { TokenGrant } from "@hootifactory/types";
import type { Action } from "./permissions";
import type { ResourceRef } from "./principal";

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

/** Specificity for precedence: exact > longest-prefix glob > org-wide "*". */
export function scopeSpecificity(pattern: string): number {
  if (pattern === "*") return 0;
  if (pattern.endsWith("*")) return pattern.length; // longer prefix => more specific
  return 100_000 + pattern.length; // exact dominates any glob
}

function repositoryGrantMatches(
  grant: Extract<TokenGrant, { resource: "repository" }>,
  resource: ResourceRef,
): boolean {
  const name = resource.repositoryName;
  return Boolean(name && patternMatches(grant.repository, name));
}

function packageGrantMatches(
  grant: Extract<TokenGrant, { resource: "package" }>,
  resource: ResourceRef,
): boolean {
  const repo = resource.repositoryName;
  const pkg = resource.packageName;
  return Boolean(
    repo && pkg && patternMatches(grant.repository, repo) && patternMatches(grant.package, pkg),
  );
}

function artifactGrantMatches(
  grant: Extract<TokenGrant, { resource: "artifact" }>,
  resource: ResourceRef,
): boolean {
  const repo = resource.repositoryName;
  const artifact = resource.artifactRef;
  return Boolean(
    repo &&
      artifact &&
      patternMatches(grant.repository, repo) &&
      patternMatches(grant.artifact, artifact),
  );
}

function policyGrantMatches(
  grant: Extract<TokenGrant, { resource: "policy" }>,
  resource: ResourceRef,
): boolean {
  if (resource.type !== "policy") return false;
  if (grant.policy !== "*" && resource.policy !== grant.policy) return false;
  if (!grant.repository) return true;
  return Boolean(
    resource.repositoryName && patternMatches(grant.repository, resource.repositoryName),
  );
}

function tokenGrantMatches(
  principalTokenId: string,
  grant: Extract<TokenGrant, { resource: "token" }>,
  resource: ResourceRef,
): boolean {
  if (resource.type !== "token") return false;
  if (grant.target === "org")
    return resource.tokenTarget === "org" || resource.tokenTarget === "self";
  return resource.tokenTarget === "self" && resource.tokenId === principalTokenId;
}

/** Does a structured token grant allow action on the resource? */
export function grantGrants(
  grants: TokenGrant[],
  resource: ResourceRef,
  action: Action,
  principalTokenId?: string,
): boolean {
  return grants.some((grant) => {
    if (!grant.actions.includes(action)) return false;
    if (grant.resource === "org") return resource.type === "org";
    if (grant.resource === "repository") {
      return (
        (resource.type === "repository" ||
          resource.type === "package" ||
          resource.type === "artifact" ||
          resource.type === "policy") &&
        repositoryGrantMatches(grant, resource)
      );
    }
    if (grant.resource === "package") {
      return resource.type === "package" && packageGrantMatches(grant, resource);
    }
    if (grant.resource === "artifact") {
      return resource.type === "artifact" && artifactGrantMatches(grant, resource);
    }
    if (grant.resource === "policy") return policyGrantMatches(grant, resource);
    if (grant.resource === "token") {
      return Boolean(principalTokenId && tokenGrantMatches(principalTokenId, grant, resource));
    }
    return false;
  });
}
