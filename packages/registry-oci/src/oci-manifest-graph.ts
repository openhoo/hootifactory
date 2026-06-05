import { safeJsonParse, z } from "@hootifactory/registry";

const OciReferenceDescriptorSchema = z.looseObject({ digest: z.string() });
const OciReferenceManifestSchema = z.looseObject({
  config: z.unknown().optional(),
  layers: z.array(z.unknown()).optional(),
  blobs: z.array(z.unknown()).optional(),
  manifests: z.array(z.unknown()).optional(),
});

function addDescriptorDigest(out: Set<string>, descriptor: unknown): void {
  const parsed = OciReferenceDescriptorSchema.safeParse(descriptor);
  if (parsed.success) out.add(parsed.data.digest);
}

export interface OciManifestReferenceLists {
  blobs: string[];
  manifests: string[];
}

export function ociManifestReferencesFromValue(value: unknown): OciManifestReferenceLists {
  const parsed = OciReferenceManifestSchema.safeParse(value);
  if (!parsed.success) return { blobs: [], manifests: [] };
  const blobs = new Set<string>();
  const manifests = new Set<string>();
  addDescriptorDigest(blobs, parsed.data.config);
  for (const layer of parsed.data.layers ?? []) addDescriptorDigest(blobs, layer);
  for (const blob of parsed.data.blobs ?? []) addDescriptorDigest(blobs, blob);
  for (const manifest of parsed.data.manifests ?? []) addDescriptorDigest(manifests, manifest);
  return { blobs: [...blobs], manifests: [...manifests] };
}

export function ociManifestReferences(raw: string): OciManifestReferenceLists {
  const parsed = safeJsonParse(raw);
  return parsed.success
    ? ociManifestReferencesFromValue(parsed.data)
    : { blobs: [], manifests: [] };
}
