import { describe, expect, test } from "bun:test";
import type { RepoContext, RouteMatch } from "@hootifactory/core";
import { NpmAdapter } from "./npm-adapter";

const whoamiMatch = {
  entry: { method: "GET", pattern: "/-/whoami", handlerId: "whoami" },
  params: {},
  path: "/-/whoami",
} satisfies RouteMatch;

describe("npm adapter contract", () => {
  test("whoami reports the token owner when token metadata is available", async () => {
    const res = await new NpmAdapter().handle(
      whoamiMatch,
      new Request("https://registry.test/-/whoami"),
      {
        principal: {
          kind: "token",
          tokenId: "tok_123",
          tokenName: "ci-token",
          orgId: "org_123",
          ownerUserId: "user_123",
          ownerUsername: "alice",
          scopes: [],
          role: null,
          isRobot: false,
        },
      } as unknown as RepoContext,
    );

    expect(await res.json()).toEqual({ username: "alice" });
  });

  test("whoami falls back to a stable token identity for unowned tokens", async () => {
    const res = await new NpmAdapter().handle(
      whoamiMatch,
      new Request("https://registry.test/-/whoami"),
      {
        principal: {
          kind: "token",
          tokenId: "tok_123",
          tokenName: "automation",
          orgId: "org_123",
          ownerUserId: null,
          ownerUsername: null,
          scopes: [],
          role: "developer",
          isRobot: true,
        },
      } as unknown as RepoContext,
    );

    expect(await res.json()).toEqual({ username: "automation" });
  });
});
