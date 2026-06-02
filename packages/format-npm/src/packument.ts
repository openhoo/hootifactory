import type { FormatMetadata } from "@hootifactory/core";

export interface VersionRow {
  version: string;
  metadata: unknown;
  createdAt: Date;
}

/** Build an npm "packument" (package metadata document) from stored versions. */
export function buildPackument(
  name: string,
  versions: VersionRow[],
  distTags: Record<string, string>,
): Record<string, unknown> {
  const versionsObj: Record<string, unknown> = {};
  const time: Record<string, string> = {};
  let created: Date | null = null;
  let modified: Date | null = null;

  for (const v of versions) {
    const manifest = (v.metadata as { manifest?: Record<string, unknown> })?.manifest ?? {
      name,
      version: v.version,
    };
    versionsObj[v.version] = manifest;
    time[v.version] = v.createdAt.toISOString();
    if (!created || v.createdAt < created) created = v.createdAt;
    if (!modified || v.createdAt > modified) modified = v.createdAt;
  }
  if (created) time.created = created.toISOString();
  if (modified) time.modified = modified.toISOString();

  const latest = distTags.latest;
  const latestManifest = latest
    ? (versionsObj[latest] as { readme?: string; description?: string } | undefined)
    : undefined;

  return {
    _id: name,
    name,
    "dist-tags": distTags,
    versions: versionsObj,
    time,
    ...(latestManifest?.description ? { description: latestManifest.description } : {}),
    ...(latestManifest?.readme ? { readme: latestManifest.readme } : {}),
  };
}

export function mergePackuments(parts: FormatMetadata[]): FormatMetadata {
  const decoder = new TextDecoder();
  const docs = parts
    .map((part) => {
      const body = typeof part.body === "string" ? part.body : decoder.decode(part.body);
      try {
        return JSON.parse(body) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((doc): doc is Record<string, unknown> => doc != null);
  const first = docs[0] ?? {};
  const versions: Record<string, unknown> = {};
  const distTags: Record<string, unknown> = {};
  const time: Record<string, unknown> = {};
  for (const doc of docs) {
    for (const [version, manifest] of Object.entries(
      (doc.versions as Record<string, unknown> | undefined) ?? {},
    )) {
      if (!Object.hasOwn(versions, version)) versions[version] = manifest;
    }
    for (const [tag, version] of Object.entries(
      (doc["dist-tags"] as Record<string, unknown> | undefined) ?? {},
    )) {
      if (!Object.hasOwn(distTags, tag)) distTags[tag] = version;
    }
    for (const [key, value] of Object.entries(
      (doc.time as Record<string, unknown> | undefined) ?? {},
    )) {
      if (!Object.hasOwn(time, key)) time[key] = value;
    }
  }
  return {
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify({
      ...first,
      "dist-tags": distTags,
      versions,
      time,
    }),
  };
}
