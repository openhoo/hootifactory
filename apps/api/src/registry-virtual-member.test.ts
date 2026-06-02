import { describe, expect, test } from "bun:test";
import type { FormatAdapter, RepoContext, ResolvedRepo, RouteMatch } from "@hootifactory/core";
import {
  type AuthAttributeSpan,
  authorizeVirtualMember,
  virtualMemberSkipReason,
} from "./registry-virtual-member";

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
  format: "npm",
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

function fakeAdapter(repositoryName?: string): FormatAdapter {
  return {
    format: "npm",
    capabilities: {
      contentAddressable: false,
      proxyable: false,
      resumableUploads: false,
      virtualizable: true,
    },
    handle: async () => new Response(null),
    routes: () => [],
    requiredPermission: () => ({ action: "read", repositoryName }),
  } as FormatAdapter;
}

function parentContext(): RepoContext {
  return {
    principal: { kind: "anonymous" },
  } as RepoContext;
}

describe("virtual member authorization", () => {
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
});
