import { describe, expect, test } from "bun:test";
import type {
  Action,
  RegistryAppRouteContext,
  RegistryPrincipal,
  ResolvedRepo,
} from "@hootifactory/registry";
import {
  dockerToRbac,
  grantDockerScope,
  ociAppRoutes,
  parseDockerScopes,
  parseTokenRequestQuery,
  requestedDockerActions,
} from "./oci-app-routes";

const principal: RegistryPrincipal = { kind: "anonymous" };

const repo = {
  id: "repo_1",
  orgId: "org_1",
  name: "containers",
  visibility: "private",
} as ResolvedRepo;

function parseOne(raw: string) {
  const parsed = parseDockerScopes([raw]);
  if (!parsed.success) throw new Error("test scope failed to parse");
  // biome-ignore lint/style/noNonNullAssertion: test fixture
  return parsed.data[0]!;
}

describe("OCI v2 version route", () => {
  test("returns the registry API version header", async () => {
    const route = ociAppRoutes().find((r) => r.method === "GET" && r.pattern === "/v2");
    const response = await route?.handler({} as RegistryAppRouteContext);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("docker-distribution-api-version")).toBe("registry/2.0");
    expect(response?.headers.get("content-type")).toContain("application/json");
    await expect(response?.json()).resolves.toEqual({});
  });
});

describe("OCI token request query parsing", () => {
  test("parses optional service and Docker scopes", () => {
    const parsed = parseTokenRequestQuery(
      new URL(
        "https://registry.test/token?service=hootifactory&scope=repository:acme/app:pull,push",
      ),
    );

    expect(parsed).toEqual({
      ok: true,
      data: {
        service: "hootifactory",
        scopes: [{ type: "repository", name: "acme/app", requested: ["pull", "push"] }],
      },
    });
  });

  test("rejects duplicate services", () => {
    const parsed = parseTokenRequestQuery(
      new URL("https://registry.test/token?service=one&service=two"),
    );

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.status).toBe(400);
      expect(parsed.body.errors[0]?.message).toBe("service may only be supplied once");
    }
  });

  test("separates query-shape and Docker scope errors", () => {
    const invalidQuery = parseTokenRequestQuery(
      new URL(`https://registry.test/token?scope=${"x".repeat(4097)}`),
    );
    const invalidScope = parseTokenRequestQuery(
      new URL("https://registry.test/token?scope=repository:acme/app:execute"),
    );

    expect(invalidQuery.ok).toBe(false);
    if (!invalidQuery.ok) expect(invalidQuery.body.errors[0]?.message).toBe("invalid token query");
    expect(invalidScope.ok).toBe(false);
    if (!invalidScope.ok) expect(invalidScope.body.errors[0]?.message).toBe("invalid token scope");
  });
});

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

  test("grants only authorized actions as generic RBAC verbs and deduplicates access", async () => {
    const calls: Action[] = [];
    const grant = await grantDockerScope(principal, parseOne("repository:acme/app:pull,*,pull"), {
      authorize: async (_principal, action) => {
        calls.push(action);
        return { allowed: action !== "write" };
      },
      resolveRepository: async () => ({ repo }),
    });

    expect(calls).toEqual(["read", "read", "write", "delete", "read"]);
    expect(grant).toEqual({
      repositoryResolved: true,
      access: { type: "repository", name: "acme/app", actions: ["read", "delete"] },
    });
  });

  test("returns empty access when the repository scope does not resolve", async () => {
    const grant = await grantDockerScope(principal, parseOne("repository:missing/app:pull"), {
      authorize: async () => {
        throw new Error("authorize should not run for unresolved repositories");
      },
      resolveRepository: async () => null,
    });

    expect(grant).toEqual({
      repositoryResolved: false,
      access: { type: "repository", name: "missing/app", actions: [] },
    });
  });
});
