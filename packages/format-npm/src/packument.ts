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
