import { z } from "@hootifactory/registry";
import { PuppetMetadataSchema, parsePuppetSlug } from "./puppet-validation";

/** The host of a configured upstream Forge base, or null if it is not a URL. */
export function puppetUpstreamHost(upstreamBase: string): string | null {
  try {
    return new URL(upstreamBase).host;
  } catch {
    return null;
  }
}

/** The upstream module-JSON URL for a slug, e.g. `<base>/v3/modules/<owner>-<name>`. */
export function puppetUpstreamModuleUrl(upstreamBase: string, slug: string): string {
  return `${upstreamBase.replace(/\/$/, "")}/v3/modules/${slug}`;
}

/** Whether an upstream-advertised file URL stays on the configured upstream host. */
export function isPuppetFileUrlOnUpstreamHost(fileUrl: string, upstreamHost: string): boolean {
  try {
    return new URL(fileUrl).host === upstreamHost;
  } catch {
    return false;
  }
}

/**
 * Resolve an upstream `file_uri` (often a host-relative path like
 * `/v3/files/x.tar.gz`) against the upstream base into an absolute URL.
 */
export function resolvePuppetFileUrl(upstreamBase: string, fileUri: string): string | null {
  try {
    return new URL(fileUri, upstreamBase).toString();
  } catch {
    return null;
  }
}

/** The relevant fields of an upstream release object on the module JSON. */
const PuppetUpstreamReleaseSchema = z.looseObject({
  version: z.string().min(1).max(256),
  metadata: PuppetMetadataSchema.optional(),
  file_uri: z.string().min(1).max(2048).optional(),
  file_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});

export type PuppetUpstreamRelease = z.output<typeof PuppetUpstreamReleaseSchema>;

const PuppetUpstreamModuleSchema = z.looseObject({
  slug: z.string().min(1).max(256),
  current_release: PuppetUpstreamReleaseSchema.optional(),
  releases: z.array(PuppetUpstreamReleaseSchema).max(5000).optional(),
});

export interface ParsedPuppetUpstreamModule {
  owner: string;
  name: string;
  slug: string;
  releases: PuppetUpstreamRelease[];
}

/**
 * Parse an upstream module JSON document into the owner/name and the (deduped)
 * set of releases to mirror. `current_release` is folded in so a module whose
 * `releases` summaries lack `file_uri` still mirrors at least its current
 * release. Returns null when the document is not a recognizable module.
 */
export function parsePuppetUpstreamModule(value: unknown): ParsedPuppetUpstreamModule | null {
  const parsed = PuppetUpstreamModuleSchema.safeParse(value);
  if (!parsed.success) return null;
  const slug = parsePuppetSlug(parsed.data.slug);
  if (!slug) return null;
  const byVersion = new Map<string, PuppetUpstreamRelease>();
  if (parsed.data.current_release) {
    byVersion.set(parsed.data.current_release.version, parsed.data.current_release);
  }
  for (const release of parsed.data.releases ?? []) {
    if (!byVersion.has(release.version)) byVersion.set(release.version, release);
  }
  return {
    owner: slug.owner,
    name: slug.name,
    slug: slug.slug,
    releases: [...byVersion.values()],
  };
}
