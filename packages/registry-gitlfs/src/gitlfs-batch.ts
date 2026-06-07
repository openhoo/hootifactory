import type { LfsBatchObject } from "./gitlfs-validation";

/** A Git LFS transfer action: an absolute href the client uploads/downloads against. */
export interface LfsAction {
  href: string;
  header?: Record<string, string>;
}

/** One object's entry in a batch response. */
export interface LfsBatchResponseObject {
  oid: string;
  size: number;
  authenticated?: boolean;
  actions?: { upload?: LfsAction; download?: LfsAction };
  error?: { code: number; message: string };
}

/** The Git LFS Batch API response body (`basic` transfer adapter). */
export interface LfsBatchResponse {
  transfer: "basic";
  objects: LfsBatchResponseObject[];
}

export type LfsOperation = "upload" | "download";

export interface BuildBatchResponseInput {
  operation: LfsOperation;
  objects: LfsBatchObject[];
  /** Absolute base for object endpoints, e.g. `${baseUrl}/${mountPath}/objects`. */
  objectsBaseUrl: string;
  /** Whether the object already exists in the store, keyed by oid. */
  exists: (oid: string) => boolean;
}

/** Build the `objects` href for a given oid. */
export function objectHref(objectsBaseUrl: string, oid: string): string {
  return `${objectsBaseUrl}/${oid}`;
}

/**
 * Build the Git LFS Batch API response.
 *
 * - `upload`: for each object that is NOT already stored, hand back an `upload`
 *   action so the client `PUT`s the content. Objects already present get no
 *   action (the client treats that as "already uploaded" and skips them).
 * - `download`: for each object that IS stored, hand back a `download` action. A
 *   missing object gets a `404` error entry per the spec.
 */
export function buildBatchResponse(input: BuildBatchResponseInput): LfsBatchResponse {
  const objects = input.objects.map((object): LfsBatchResponseObject => {
    const present = input.exists(object.oid);
    const href = objectHref(input.objectsBaseUrl, object.oid);
    if (input.operation === "upload") {
      // Already-stored objects need no action; the client skips them.
      if (present) return { oid: object.oid, size: object.size, authenticated: true };
      return {
        oid: object.oid,
        size: object.size,
        authenticated: true,
        actions: { upload: { href } },
      };
    }
    if (!present) {
      return {
        oid: object.oid,
        size: object.size,
        error: { code: 404, message: "object does not exist" },
      };
    }
    return {
      oid: object.oid,
      size: object.size,
      authenticated: true,
      actions: { download: { href } },
    };
  });
  return { transfer: "basic", objects };
}
