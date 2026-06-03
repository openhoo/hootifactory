import { describe, expect, test } from "bun:test";
import {
  buildOciBlobCreatedResponse,
  buildOciUploadAcceptedResponse,
  buildOciUploadCommittedResponse,
  buildOciUploadStatusResponse,
  ociBlobLocation,
  ociUploadLocation,
  ociUploadRange,
} from "./oci-upload-responses";

const ctx = {
  baseUrl: "https://registry.test",
  repo: { mountPath: "v2/acme/containers" },
};

describe("OCI upload response helpers", () => {
  test("builds stable blob and upload locations", () => {
    expect(
      ociUploadLocation({
        ctx,
        image: "team/api",
        uuid: "upload-1",
      }),
    ).toBe("https://registry.test/v2/acme/containers/team/api/blobs/uploads/upload-1");
    expect(
      ociBlobLocation({
        ctx,
        image: "team/api",
        digest: "sha256:abc",
      }),
    ).toBe("https://registry.test/v2/acme/containers/team/api/blobs/sha256:abc");
  });

  test("formats upload offset ranges like the Docker registry protocol", () => {
    expect(ociUploadRange(0)).toBe("0-0");
    expect(ociUploadRange(1)).toBe("0-0");
    expect(ociUploadRange(11)).toBe("0-10");
  });

  test("builds blob-created responses for mounts and monolithic uploads", async () => {
    const response = buildOciBlobCreatedResponse({
      ctx,
      image: "app",
      digest: "sha256:abc",
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("location")).toBe(
      "https://registry.test/v2/acme/containers/app/blobs/sha256:abc",
    );
    expect(response.headers.get("docker-content-digest")).toBe("sha256:abc");
    expect(response.headers.get("content-length")).toBe("0");
    expect(await response.text()).toBe("");
  });

  test("builds accepted and status responses for resumable uploads", () => {
    const accepted = buildOciUploadAcceptedResponse({
      ctx,
      image: "app",
      uuid: "upload-1",
      offset: 5,
    });
    expect(accepted.status).toBe(202);
    expect(accepted.headers.get("location")).toBe(
      "https://registry.test/v2/acme/containers/app/blobs/uploads/upload-1",
    );
    expect(accepted.headers.get("range")).toBe("0-4");
    expect(accepted.headers.get("docker-upload-uuid")).toBe("upload-1");
    expect(accepted.headers.get("content-length")).toBe("0");

    const status = buildOciUploadStatusResponse({
      ctx,
      image: "app",
      uuid: "upload-1",
      offset: 5,
    });
    expect(status.status).toBe(204);
    expect(status.headers.get("range")).toBe("0-4");
    expect(status.headers.get("docker-upload-uuid")).toBe("upload-1");
    expect(status.headers.get("location")).toBe(
      "https://registry.test/v2/acme/containers/app/blobs/uploads/upload-1",
    );
    expect(status.headers.get("content-length")).toBeNull();
  });

  test("builds committed upload responses with digest and upload ranges", () => {
    const response = buildOciUploadCommittedResponse({
      ctx,
      image: "app",
      digest: "sha256:def",
      size: 11,
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("location")).toBe(
      "https://registry.test/v2/acme/containers/app/blobs/sha256:def",
    );
    expect(response.headers.get("docker-content-digest")).toBe("sha256:def");
    expect(response.headers.get("content-length")).toBe("0");
    expect(response.headers.get("content-range")).toBe("0-10");
    expect(response.headers.get("range")).toBe("0-10");
  });
});
