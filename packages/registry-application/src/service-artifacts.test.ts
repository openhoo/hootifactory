import { describe, expect, test } from "bun:test";
import { artifacts, scanPolicies } from "@hootifactory/db";
import type { RegistryRequestContext } from "@hootifactory/registry";
import { serveBlobIfClean } from "./service-artifacts";

/**
 * Minimal RegistryRequestContext whose db answers the two reads isArtifactBlocked makes:
 * the scanPolicies list (empty) and the artifact row (with the given state).
 */
function ctxForArtifactState(state: string): RegistryRequestContext {
  const select = () => {
    let table: unknown;
    const qb = {
      from: (t: unknown) => {
        table = t;
        return qb;
      },
      where: () => qb,
      limit: () => qb,
      // biome-ignore lint/suspicious/noThenProperty: a drizzle query builder is itself a thenable; this mock mirrors that so `await` resolves the rows.
      then: (resolve: (rows: unknown) => void) =>
        resolve(table === scanPolicies ? [] : table === artifacts ? [{ state }] : []),
    };
    return qb;
  };
  return {
    repo: { orgId: "org", id: "repo", name: "repo" },
    db: { select },
    blobs: { get: () => "BYTES" },
  } as unknown as RegistryRequestContext;
}

describe("serveBlobIfClean", () => {
  test("a blocked artifact returns blocked() even when notModified would fire", async () => {
    // Regression guard: the scan-policy block check MUST run before any 304
    // short-circuit, otherwise a quarantined artifact could be answered with a
    // cacheable 304 instead of a 403.
    const res = await serveBlobIfClean(ctxForArtifactState("blocked"), {
      digest: "sha256:deadbeef",
      contentType: "application/octet-stream",
      blocked: () => new Response("blocked by scan policy", { status: 403 }),
      notModified: () => new Response(null, { status: 304 }),
    });
    expect(res.status).toBe(403);
  });

  test("a clean artifact honors notModified before serving bytes", async () => {
    const res = await serveBlobIfClean(ctxForArtifactState("clean"), {
      digest: "sha256:deadbeef",
      contentType: "application/octet-stream",
      blocked: () => new Response("blocked by scan policy", { status: 403 }),
      notModified: () => new Response(null, { status: 304 }),
    });
    expect(res.status).toBe(304);
  });

  test("a clean artifact with no 304 serves the bytes with the given content-type", async () => {
    const res = await serveBlobIfClean(ctxForArtifactState("clean"), {
      digest: "sha256:deadbeef",
      contentType: "application/octet-stream",
      extraHeaders: { etag: '"abc"' },
      blocked: () => new Response("blocked by scan policy", { status: 403 }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("etag")).toBe('"abc"');
    expect(await res.text()).toBe("BYTES");
  });
});
