import { describe, expect, test } from "bun:test";
import * as auth from "./index";

describe("public @hootifactory/auth barrel", () => {
  test("re-exports the core auth surface from its submodules", () => {
    // A representative function from each re-exported module must be reachable
    // via the package entry point.
    expect(typeof auth.writeAudit).toBe("function"); // audit
    expect(typeof auth.authorize).toBe("function"); // authorize
    expect(typeof auth.can).toBe("function"); // can
    expect(typeof auth.resolveCreateApiTokenRequest).toBe("function"); // create-token-request
    expect(typeof auth.createAuthEmailToken).toBe("function"); // email-tokens
    expect(typeof auth.mapGroupsToOrgRoles).toBe("function"); // oidc
    expect(typeof auth.mergeAccessibleOrgs).toBe("function"); // organizations
    expect(typeof auth.hashPassword).toBe("function"); // password
    expect(typeof auth.roleAllows).toBe("function"); // permissions
    expect(typeof auth.isAnonymous).toBe("function"); // principal
    expect(typeof auth.issueRegistryToken).toBe("function"); // registry-jwt
    expect(typeof auth.grantGrants).toBe("function"); // scope
    expect(typeof auth.createSession).toBe("function"); // sessions
    expect(typeof auth.consumeSharedAuthThrottleBucket).toBe("function"); // throttle
    expect(typeof auth.validateTokenGrant).toBe("function"); // token-grants
    expect(typeof auth.principalActor).toBe("function"); // token-management
    expect(typeof auth.createApiToken).toBe("function"); // tokens
    expect(typeof auth.createLocalUser).toBe("function"); // users
  });
});
