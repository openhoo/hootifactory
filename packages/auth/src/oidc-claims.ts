import type { OidcGroupGrant, OidcGroupMappings } from "./oidc-types";

export function mapGroupsToOrgGroups(
  groups: string[],
  groupMappings: OidcGroupMappings,
): OidcGroupGrant[] {
  const byOrgGroup = new Map<string, OidcGroupGrant>();
  for (const idpGroup of groups) {
    const grants = Object.hasOwn(groupMappings, idpGroup) ? groupMappings[idpGroup] : undefined;
    for (const grant of grants ?? []) {
      const key = `${grant.org}\0${grant.group}`;
      const existing = byOrgGroup.get(key);
      if (existing) {
        if (!existing.groups.includes(idpGroup)) existing.groups.push(idpGroup);
      } else {
        byOrgGroup.set(key, { org: grant.org, group: grant.group, groups: [idpGroup] });
      }
    }
  }
  return [...byOrgGroup.values()];
}
