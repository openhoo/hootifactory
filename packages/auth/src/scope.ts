import type { TokenScope } from "@hootifactory/db";
import type { Action } from "./permissions";

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

/** Specificity for precedence: exact > longest-prefix glob > org-wide "*". */
export function scopeSpecificity(pattern: string): number {
  if (pattern === "*") return 0;
  if (pattern.endsWith("*")) return pattern.length; // longer prefix => more specific
  return 100_000 + pattern.length; // exact dominates any glob
}

/** Does any scope grant `action` for `name`? (scopes only grant, never deny.) */
export function scopeGrants(scopes: TokenScope[], name: string, action: Action): boolean {
  return scopes.some((s) => patternMatches(s.repository, name) && s.actions.includes(action));
}
