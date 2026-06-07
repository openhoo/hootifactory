import { describe, expect, test } from "bun:test";
import type {
  RegistryRequestContext,
  RegistryUploadedBlob,
  RegistryUploadSessionMutations,
  RegistryUploadSessionRow,
} from "@hootifactory/registry";
import { createTestRegistryContext } from "@hootifactory/registry/testing";
import { cancelUpload, patchUpload, putUpload, startUpload, uploadStatus } from "./oci-uploads";

const IMAGE = "team/api";
const UPLOAD_UUID = "11111111-1111-4111-8111-111111111111";
const DIGEST = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const MOUNT_DIGEST = "sha256:2222222222222222222222222222222222222222222222222222222222222222";

function ctxFor(overrides: Partial<RegistryRequestContext> = {}): RegistryRequestContext {
  const ctx = createTestRegistryContext({ baseUrl: "https://registry.test", ...overrides });
  ctx.repo = { ...ctx.repo, moduleId: "docker", mountPath: "v2/acme/containers" };
  return ctx;
}

function session(overrides: Partial<RegistryUploadSessionRow> = {}): RegistryUploadSessionRow {
  return {
    id: UPLOAD_UUID,
    repositoryId: "repo_1",
    scope: IMAGE,
    storageKey: "oci/uploads/upload_1",
    offsetBytes: 0,
    state: "open",
    multipart: null,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function noopMutations(
  overrides: Partial<RegistryUploadSessionMutations> = {},
): RegistryUploadSessionMutations {
  return {
    assertStagingBudget: async () => {},
    updateOpen: async () => {},
    commitBlobWithRef: async () => {
      throw new Error("commitBlobWithRef not expected");
    },
    commit: async () => {},
    markAborted: async () => {},
    deleteSession: async () => {},
    ...overrides,
  };
}

describe("OCI startUpload", () => {
  test("opens a resumable upload session when no digest or mount is supplied", async () => {
    const ctx = ctxFor();
    let createdId = "";
    let createdScope = "";
    ctx.data.contentStore.createUploadSession = async (input) => {
      createdId = input.id;
      createdScope = input.scope;
      expect(input.offsetBytes).toBe(0);
      expect(input.expiresAt.getTime()).toBeGreaterThan(Date.now());
    };

    const response = await startUpload(
      IMAGE,
      new Request("https://registry.test/v2/acme/containers/team/api/blobs/uploads", {
        method: "POST",
      }),
      ctx,
    );

    expect(response.status).toBe(202);
    expect(createdScope).toBe(IMAGE);
    expect(response.headers.get("docker-upload-uuid")).toBe(createdId);
    expect(response.headers.get("location")).toContain(`/team/api/blobs/uploads/${createdId}`);
    expect(response.headers.get("range")).toBe("0-0");
  });

  test("streams monolithic digest uploads straight to the blob store", async () => {
    const ctx = ctxFor();
    let stored = 0;
    ctx.data.content.storeBlobStreamWithRef = async (input) => {
      stored += 1;
      expect(input.expectedDigest).toBe(DIGEST);
      expect(input.kind).toBe("oci_layer");
      expect(input.scope).toBe(IMAGE);
      return { digest: DIGEST, size: 5, deduped: false, refCreated: true, blobRefId: "ref_1" };
    };

    const response = await startUpload(
      IMAGE,
      new Request(
        `https://registry.test/v2/acme/containers/team/api/blobs/uploads?digest=${DIGEST}`,
        { method: "POST", body: "layer" },
      ),
      ctx,
    );

    expect(stored).toBe(1);
    expect(response.status).toBe(201);
    expect(response.headers.get("docker-content-digest")).toBe(DIGEST);
  });

  test("maps a digest mismatch on monolithic upload to DIGEST_INVALID", async () => {
    const ctx = ctxFor();
    const { InvalidDigestError } = await import("@hootifactory/registry");
    ctx.data.content.storeBlobStreamWithRef = async () => {
      throw new InvalidDigestError("digest mismatch");
    };

    await expect(
      startUpload(
        IMAGE,
        new Request(
          `https://registry.test/v2/acme/containers/team/api/blobs/uploads?digest=${DIGEST}`,
          { method: "POST", body: "layer" },
        ),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 400, code: "DIGEST_INVALID" });
  });

  test("rethrows non-digest errors from the blob store unchanged", async () => {
    const ctx = ctxFor();
    ctx.data.content.storeBlobStreamWithRef = async () => {
      throw new Error("storage offline");
    };

    await expect(
      startUpload(
        IMAGE,
        new Request(
          `https://registry.test/v2/acme/containers/team/api/blobs/uploads?digest=${DIGEST}`,
          { method: "POST", body: "layer" },
        ),
        ctx,
      ),
    ).rejects.toThrow("storage offline");
  });

  test("cross-repository mount reuses an authorized source blob", async () => {
    const ctx = ctxFor();
    let ensuredDigest = "";
    let ensuredScope = "";
    ctx.data.contentStore.listMountSources = async (mount) => {
      expect(mount).toBe(MOUNT_DIGEST);
      return [
        {
          orgId: "org_1",
          id: "repo_src",
          mountPath: "v2/acme/source",
          visibility: "private",
          scope: "lib/base",
        },
      ];
    };
    ctx.authorize = async (action, resource) => {
      expect(action).toBe("read");
      expect(resource?.repositoryName).toBe("acme/source/lib/base");
      return { allowed: true };
    };
    ctx.data.content.ensureBlobRef = async (input) => {
      ensuredDigest = input.digest;
      ensuredScope = input.scope;
      return { digest: input.digest, size: 0, refCreated: false, blobRefId: "ref_mount" };
    };

    const response = await startUpload(
      IMAGE,
      new Request(
        `https://registry.test/v2/acme/containers/team/api/blobs/uploads?mount=${MOUNT_DIGEST}`,
        { method: "POST" },
      ),
      ctx,
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("docker-content-digest")).toBe(MOUNT_DIGEST);
    expect(ensuredDigest).toBe(MOUNT_DIGEST);
    expect(ensuredScope).toBe(IMAGE);
  });

  test("filters mount sources by `from` and falls through to a session when unauthorized", async () => {
    const ctx = ctxFor();
    let created = false;
    ctx.data.contentStore.listMountSources = async () => [
      {
        orgId: "org_1",
        id: "repo_a",
        mountPath: "v2/acme/source-a",
        visibility: "private",
        scope: "lib/base",
      },
      {
        orgId: "org_1",
        id: "repo_b",
        mountPath: "v2/acme/source-b",
        visibility: "private",
        scope: "lib/base",
      },
    ];
    const authorized: string[] = [];
    ctx.authorize = async (_action, resource) => {
      authorized.push(resource?.repositoryName ?? "");
      return { allowed: false };
    };
    ctx.data.content.ensureBlobRef = async () => {
      throw new Error("ensureBlobRef should not run when no source is authorized");
    };
    ctx.data.contentStore.createUploadSession = async () => {
      created = true;
    };

    const response = await startUpload(
      IMAGE,
      new Request(
        `https://registry.test/v2/acme/containers/team/api/blobs/uploads?mount=${MOUNT_DIGEST}&from=acme/source-b/lib/base`,
        { method: "POST" },
      ),
      ctx,
    );

    // Only the `from`-matched source is considered.
    expect(authorized).toEqual(["acme/source-b/lib/base"]);
    expect(created).toBe(true);
    expect(response.status).toBe(202);
  });
});

describe("OCI uploadStatus", () => {
  test("reports the staged offset of an open session", async () => {
    const ctx = ctxFor();
    ctx.data.contentStore.loadUploadSession = async ({ scope, uuid }) => {
      expect(scope).toBe(IMAGE);
      expect(uuid).toBe(UPLOAD_UUID);
      return session({ offsetBytes: 7 });
    };

    const response = await uploadStatus(IMAGE, UPLOAD_UUID, ctx);

    expect(response.status).toBe(204);
    expect(response.headers.get("range")).toBe("0-6");
    expect(response.headers.get("docker-upload-uuid")).toBe(UPLOAD_UUID);
  });

  test("rejects an unknown session", async () => {
    const ctx = ctxFor();
    ctx.data.contentStore.loadUploadSession = async () => null;

    await expect(uploadStatus(IMAGE, UPLOAD_UUID, ctx)).rejects.toMatchObject({
      code: "BLOB_UPLOAD_UNKNOWN",
    });
  });

  test("rejects a malformed upload uuid before touching the data layer", async () => {
    const ctx = ctxFor();
    ctx.data.contentStore.loadUploadSession = async () => {
      throw new Error("loadUploadSession should not run for an invalid uuid");
    };

    await expect(uploadStatus(IMAGE, "not-a-uuid", ctx)).rejects.toMatchObject({
      status: 400,
      code: "BLOB_UPLOAD_INVALID",
    });
  });

  test("aborts and rejects an expired session", async () => {
    const ctx = ctxFor();
    let marked = false;
    ctx.data.contentStore.loadUploadSession = async () =>
      session({ expiresAt: new Date(Date.now() - 1_000) });
    ctx.data.contentStore.markUploadSessionAborted = async ({ scope, uuid }) => {
      expect(scope).toBe(IMAGE);
      expect(uuid).toBe(UPLOAD_UUID);
      marked = true;
    };

    await expect(uploadStatus(IMAGE, UPLOAD_UUID, ctx)).rejects.toMatchObject({
      code: "BLOB_UPLOAD_UNKNOWN",
    });
    expect(marked).toBe(true);
  });

  test("rejects a session that is no longer open", async () => {
    const ctx = ctxFor();
    ctx.data.contentStore.loadUploadSession = async () => session({ state: "committed" });

    await expect(uploadStatus(IMAGE, UPLOAD_UUID, ctx)).rejects.toMatchObject({
      code: "BLOB_UPLOAD_UNKNOWN",
    });
  });
});

describe("OCI cancelUpload", () => {
  test("clears staged chunks, deletes the session, and returns 204", async () => {
    const ctx = ctxFor();
    const events: string[] = [];
    ctx.data.content.staging.deleteKey = async (key) => {
      events.push(`delete:${key}`);
    };
    ctx.data.contentStore.withLockedUploadSession = async ({ run }) => {
      const mutations = noopMutations({
        deleteSession: async () => {
          events.push("deleteSession");
        },
      });
      return run(
        session({
          storageKey: "oci/uploads/upload_1",
          multipart: JSON.stringify({ chunks: [{ key: "chunk-0", size: 3 }] }),
        }),
        mutations,
      );
    };

    const response = await cancelUpload(IMAGE, UPLOAD_UUID, ctx);

    expect(response.status).toBe(204);
    expect(events).toContain("delete:oci/uploads/upload_1");
    expect(events).toContain("delete:chunk-0");
    expect(events).toContain("deleteSession");
  });
});

describe("OCI patchUpload offset validation", () => {
  test("rejects when an existing staged offset no longer matches the session offset", async () => {
    const ctx = ctxFor();
    ctx.data.contentStore.withLockedUploadSession = async ({ run }) =>
      run(
        session({
          // Recorded offset disagrees with the staged chunk sizes (existing = 0).
          offsetBytes: 99,
        }),
        noopMutations(),
      );

    await expect(
      patchUpload(
        IMAGE,
        UPLOAD_UUID,
        new Request(
          `https://registry.test/v2/acme/containers/team/api/blobs/uploads/${UPLOAD_UUID}`,
          { method: "PATCH", body: "layer" },
        ),
        ctx,
      ),
    ).rejects.toMatchObject({ code: "BLOB_UPLOAD_INVALID" });
  });

  test("removes the staged chunk when the second locked pass fails", async () => {
    const ctx = ctxFor();
    const deleted: string[] = [];
    let pass = 0;
    ctx.data.content.staging.putKey = async () => {};
    ctx.data.content.staging.deleteKey = async (key) => {
      deleted.push(key);
    };
    ctx.data.contentStore.withLockedUploadSession = async ({ run }) => {
      pass += 1;
      if (pass === 1) {
        return run(session(), noopMutations());
      }
      // Second pass: simulate a concurrent writer advancing the offset.
      return run(session({ offsetBytes: 5 }), noopMutations());
    };

    await expect(
      patchUpload(
        IMAGE,
        UPLOAD_UUID,
        new Request(
          `https://registry.test/v2/acme/containers/team/api/blobs/uploads/${UPLOAD_UUID}`,
          { method: "PATCH", body: "layer" },
        ),
        ctx,
      ),
    ).rejects.toMatchObject({ code: "BLOB_UPLOAD_INVALID" });
    expect(deleted.length).toBe(1);
  });
});

describe("OCI putUpload error handling", () => {
  test("discards the uploaded blob and maps digest mismatches", async () => {
    const ctx = ctxFor();
    const { InvalidDigestError } = await import("@hootifactory/registry");
    let discarded = false;
    ctx.data.contentStore.withLockedUploadSession = async ({ run }) =>
      run(session(), noopMutations());
    ctx.data.content.uploadBlobStream = async () => {
      throw new InvalidDigestError("digest mismatch");
    };
    ctx.data.content.discardUploadedBlob = async () => {
      discarded = true;
    };

    await expect(
      putUpload(
        IMAGE,
        UPLOAD_UUID,
        new Request(
          `https://registry.test/v2/acme/containers/team/api/blobs/uploads/${UPLOAD_UUID}?digest=${DIGEST}`,
          { method: "PUT", body: "layer" },
        ),
        ctx,
      ),
    ).rejects.toMatchObject({ status: 400, code: "DIGEST_INVALID" });
    // The blob never finished uploading, so nothing is discarded.
    expect(discarded).toBe(false);
  });

  test("discards a committed-but-unpersisted blob if the commit transaction fails", async () => {
    const ctx = ctxFor();
    let discardedDigest = "";
    const uploaded: RegistryUploadedBlob = { digest: DIGEST, size: 5, deduped: false };
    let pass = 0;
    ctx.data.contentStore.withLockedUploadSession = async ({ run }) => {
      pass += 1;
      if (pass === 1) return run(session(), noopMutations());
      // Second locked pass: blow up after the blob was uploaded.
      throw new Error("commit transaction failed");
    };
    ctx.data.content.uploadBlobStream = async () => uploaded;
    ctx.data.content.discardUploadedBlob = async (blob) => {
      discardedDigest = blob.digest;
    };

    await expect(
      putUpload(
        IMAGE,
        UPLOAD_UUID,
        new Request(
          `https://registry.test/v2/acme/containers/team/api/blobs/uploads/${UPLOAD_UUID}?digest=${DIGEST}`,
          { method: "PUT", body: "layer" },
        ),
        ctx,
      ),
    ).rejects.toThrow("commit transaction failed");
    expect(discardedDigest).toBe(DIGEST);
  });
});
