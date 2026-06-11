import { describe, expect, test } from "bun:test";
import type {
  RegistryPlugin,
  RegistryRequestContext,
  ResolvedRepo,
  RouteMatch,
} from "@hootifactory/registry";
import {
  type AuthAttributeSpan,
  authorizeVirtualMember,
  authorizeVirtualMembers,
  mapVirtualMemberAuthorizations,
  virtualMemberSkipReason,
  withVirtualMemberSpans,
} from "./virtual-member";

const route: RouteMatch = {
  entry: { method: "GET", pattern: "/:pkg+", handlerId: "packument" },
  params: { pkg: "package" },
  path: "package",
};

const publicMember = {
  id: "repo_member",
  orgId: "org_1",
  name: "member",
  kind: "hosted",
  moduleId: "npm",
  visibility: "public",
  mountPath: "member",
} as ResolvedRepo;

const privateMember = { ...publicMember, visibility: "private" } as ResolvedRepo;

function fakeSpan() {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    span: {
      setAttributes(attributes: Record<string, unknown>) {
        calls.push(attributes);
      },
    } as AuthAttributeSpan,
  };
}

function fakeAdapter(repositoryName?: string): RegistryPlugin {
  return {
    id: "npm",
    displayName: "npm",
    mountSegment: "npm",
    apiKeyHeaders: new Set(),
    errorResponseKind: "singleError",
    compressibleHandlers: new Set(),
    compressibleContentTypes: new Set(),
    capabilities: {
      contentAddressable: false,
      proxyable: false,
      resumableUploads: false,
      virtualizable: true,
    },
    handle: async () => new Response(null),
    routes: () => [],
    requiredPermission: () => ({ action: "read", repositoryName }),
  } as RegistryPlugin;
}

function parentContext(): RegistryRequestContext {
  return {
    principal: { kind: "anonymous" },
  } as RegistryRequestContext;
}

describe("virtual member authorization", () => {
  test("runs member span handlers concurrently while preserving member order", async () => {
    const members = [
      { ...publicMember, id: "repo_1", name: "one" },
      { ...publicMember, id: "repo_2", name: "two" },
      { ...publicMember, id: "repo_3", name: "three" },
    ];
    let inFlight = 0;
    let maxInFlight = 0;

    const names = await withVirtualMemberSpans(members, "test.virtual.member", async (member) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return member.name;
    });

    expect(names).toEqual(["one", "two", "three"]);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  test("builds member context and records allowed auth attributes", async () => {
    const { calls, span } = fakeSpan();

    const authorization = await authorizeVirtualMember(
      fakeAdapter("member"),
      "GET",
      route,
      publicMember,
      parentContext(),
      span,
    );

    expect(authorization.decision.allowed).toBe(true);
    expect(authorization.permission).toEqual({ action: "read", repositoryName: "member" });
    expect(authorization.memberCtx.repo).toBe(publicMember);
    expect(authorization.memberCtx.principal).toEqual({ kind: "anonymous" });
    expect(calls).toEqual([{ "auth.action": "read", "auth.decision": "allowed" }]);
  });

  test("records denied auth attributes and exposes a stable skip reason", async () => {
    const { calls, span } = fakeSpan();

    const authorization = await authorizeVirtualMember(
      fakeAdapter(),
      "GET",
      route,
      privateMember,
      parentContext(),
      span,
    );

    expect(authorization.decision.allowed).toBe(false);
    expect(virtualMemberSkipReason(authorization)).toBe("authentication required");
    expect(calls).toEqual([{ "auth.action": "read", "auth.decision": "denied" }]);
  });

  test("virtualMemberSkipReason falls back to the decision code then a default", () => {
    expect(
      virtualMemberSkipReason({
        decision: { allowed: false, code: "insufficient_scope" },
      } as never),
    ).toBe("insufficient_scope");
    expect(virtualMemberSkipReason({ decision: { allowed: false } } as never)).toBe("denied");
  });

  test("authorizeVirtualMembers authorizes every member and pairs results with members", async () => {
    const members = [
      { ...publicMember, id: "repo_pub", name: "public" },
      { ...privateMember, id: "repo_priv", name: "private" },
    ];

    const authorizations = await authorizeVirtualMembers(
      fakeAdapter("public"),
      "GET",
      route,
      members,
      parentContext(),
      "test.virtual.member",
    );

    expect(authorizations.map((a) => a.member.name)).toEqual(["public", "private"]);
    expect(authorizations[0]?.authorization.decision.allowed).toBe(true);
    expect(authorizations[1]?.authorization.decision.allowed).toBe(false);
  });

  test("mapVirtualMemberAuthorizations applies a handler to each authorization", async () => {
    const members = [
      { ...publicMember, id: "repo_1", name: "one" },
      { ...publicMember, id: "repo_2", name: "two" },
    ];
    const authorizations = await authorizeVirtualMembers(
      fakeAdapter("one"),
      "GET",
      route,
      members,
      parentContext(),
      "test.virtual.member",
    );

    const names = await mapVirtualMemberAuthorizations(authorizations, async ({ member }) =>
      member.name.toUpperCase(),
    );
    expect(names).toEqual(["ONE", "TWO"]);
  });
});
