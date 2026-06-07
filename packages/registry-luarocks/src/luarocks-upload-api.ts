/**
 * The LuaRocks.org-compatible upload API (`luarocks upload --api-key=<key>`).
 *
 * The real `luarocks upload` command (src/luarocks/cmd/upload.lua) drives a
 * three-step flow against `<server>/api/1/<key>/<method>`:
 *
 *   1. GET  check_rockspec?package=&version=  — reads `res.module` (truthy when
 *      the module already exists) and `res.version` (truthy when this exact
 *      revision is already published, which blocks re-upload without `--force`).
 *   2. POST upload  (multipart `rockspec_file`)  — reads `res.version.id` (an
 *      integer it formats with `("%d"):format(id)`), `res.is_new`,
 *      `#res.manifests`, and `res.module_url`.
 *   3. POST upload_rock/<id>  (multipart `rock_file`)  — attaches the packed
 *      `.rock` to the version addressed by the integer id from step 2.
 *
 * Because `version.id` must round-trip through `("%d"):format(id)`, it has to be
 * an integer; our package-version rows carry opaque string ids instead. We
 * therefore derive a stable positive integer from the version row's unique id
 * and remember the id -> rock@version mapping for the brief window between
 * `/upload` and `/upload_rock` (a single `luarocks upload` invocation issues
 * both POSTs back-to-back against the same server), so `upload_rock/<id>` can
 * resolve the version it must attach the binary rock to.
 */

import { BoundedLruCache } from "@hootifactory/registry";

/** Resolved coordinates for an upload-API integer version id. */
export interface UploadApiVersionRef {
  rock: string;
  version: string;
}

/**
 * Derive the stable positive integer the upload API advertises as `version.id`
 * for a given package-version row. FNV-1a over the row's unique id, masked to a
 * non-zero 31-bit value so it survives `math.tointeger`/`("%d"):format` on the
 * client and never collides with the 0 sentinel the client treats as "no id".
 */
export function uploadApiVersionId(versionRowId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < versionRowId.length; i++) {
    hash ^= versionRowId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Keep the low 31 bits (always coerced to >= 1) so the value is a safe
  // positive integer the client can format with `("%d"):format`.
  return hash & 0x7fffffff || 1;
}

/**
 * Short-lived id -> rock@version map bridging `/upload` and `/upload_rock`
 * within one `luarocks upload` invocation. Bounded so a long-running server
 * cannot accumulate entries; resolution failures degrade to a 404 on
 * `upload_rock`, leaving the already-published rockspec intact.
 */
export class UploadApiVersionRegistry {
  private readonly entries = new BoundedLruCache<number, UploadApiVersionRef>(1024);

  remember(versionId: number, ref: UploadApiVersionRef): void {
    this.entries.set(versionId, ref);
  }

  resolve(versionId: number): UploadApiVersionRef | null {
    return this.entries.get(versionId) ?? null;
  }
}
