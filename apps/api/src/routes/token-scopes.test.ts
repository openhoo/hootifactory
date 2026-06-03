import { describe, expect, test } from "bun:test";
import type { Action, Principal } from "@hootifactory/auth";
import type { ResolvedRepo } from "@hootifactory/registry";
import {
  dockerToRbac,
  grantDockerScope,
  parseDockerScopes,
  requestedDockerActions,
} from "./token-scopes";

const principal: Principal = { kind: "anonymous" };

const repo = {
  id: "repo_1",
  orgId: "org_1",
  name: "containers",
  visibility: "private",
} as ResolvedRepo;

function parseOne(raw: string) {
  const parsed = parseDockerScopes([raw]);
  if (!parsed.success) throw new Error("test scope failed to parse");
  return parsed.data[0]!;
}

describe("OCI token scope helpers", () => {
  test("parses space-separated Docker repository scopes", () => {
    const parsed = parseDockerScopes(["repository:acme/app:pull,push repository:team/api:*"]);

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual([
        { type: "repository", name: "acme/app", requested: ["pull", "push"] },
        { type: "repository", name: "team/api", requested: ["*"] },
      ]);
    }
  });

  test("rejects malformed scope shapes and unsupported actions", () => {
    expect(parseDockerScopes(["registry:acme/app:pull"]).success).toBe(false);
    expect(parseDockerScopes(["repository:/acme/app:pull"]).success).toBe(false);
    expect(parseDockerScopes(["repository:acme/app:execute"]).success).toBe(false);
    expect(parseDockerScopes(["repository:acme/app:"]).success).toBe(false);
  });

  test("maps Docker actions to RBAC actions and expands wildcards", () => {
    expect(dockerToRbac("pull")).toBe("read");
    expect(dockerToRbac("push")).toBe("write");
    expect(dockerToRbac("delete")).toBe("delete");
    expect(dockerToRbac("*")).toBeNull();
    expect(requestedDockerActions(parseOne("repository:acme/app:pull,*,delete"))).toEqual([
      "pull",
      "pull",
      "push",
      "delete",
      "delete",
    ]);
  });

  test("grants only authorized Docker actions and deduplicates access", async () => {
    const calls: Action[] = [];
    const grant = await grantDockerScope(principal, parseOne("repository:acme/app:pull,*,pull"), {
      authorizeAction: async (_principal, action) => {
        calls.push(action);
        return { allowed: action !== "write" };
      },
      resolveRepositoryPath: async () => ({ repo, rest: "" }),
    });

    expect(calls).toEqual(["read", "read", "write", "delete", "read"]);
    expect(grant).toEqual({
      repositoryResolved: true,
      access: { type: "repository", name: "acme/app", actions: ["pull", "delete"] },
    });
  });

  test("returns empty access when the repository scope does not resolve", async () => {
    const grant = await grantDockerScope(principal, parseOne("repository:missing/app:pull"), {
      authorizeAction: async () => {
        throw new Error("authorize should not run for unresolved repositories");
      },
      resolveRepositoryPath: async () => null,
    });

    expect(grant).toEqual({
      repositoryResolved: false,
      access: { type: "repository", name: "missing/app", actions: [] },
    });
  });
});
