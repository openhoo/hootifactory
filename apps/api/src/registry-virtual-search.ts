import { parseRegistryInput, z } from "@hootifactory/registry";

const NpmSearchWindowSchema = z.strictObject({
  from: z.coerce.number().int().min(0).max(10_000).default(0),
  size: z.coerce.number().int().min(0).max(100).default(20),
});

const NugetSearchWindowSchema = z.strictObject({
  skip: z.coerce.number().int().min(0).max(10_000).default(0),
  take: z.coerce.number().int().min(0).max(100).default(20),
});

const NPM_MEMBER_SEARCH_SIZE = 250;

export interface NpmSearchWindow {
  from: number;
  size: number;
}

export interface NugetSearchWindow {
  skip: number;
  take: number;
}

const NpmSearchPackageSchema = z.looseObject({ name: z.unknown().optional() });
const NpmSearchObjectSchema = z.looseObject({
  package: NpmSearchPackageSchema.optional(),
});
const NpmSearchBodySchema = z.looseObject({
  objects: z.array(NpmSearchObjectSchema).optional(),
  total: z.number().int().nonnegative().optional(),
});

const NugetSearchItemSchema = z.looseObject({ id: z.unknown().optional() });
const NugetSearchBodySchema = z.looseObject({
  data: z.array(NugetSearchItemSchema).optional(),
  totalHits: z.number().int().nonnegative().optional(),
});

export type NpmSearchBody = z.output<typeof NpmSearchBodySchema>;
export type NugetSearchBody = z.output<typeof NugetSearchBodySchema>;

export function npmSearchWindow(req: Request): NpmSearchWindow {
  const url = new URL(req.url);
  return parseRegistryInput(
    NpmSearchWindowSchema,
    {
      from: url.searchParams.get("from") ?? undefined,
      size: url.searchParams.get("size") ?? undefined,
    },
    { code: "PAGINATION_NUMBER_INVALID", message: "invalid search pagination" },
  );
}

export function nugetSearchWindow(req: Request): NugetSearchWindow {
  const url = new URL(req.url);
  return parseRegistryInput(
    NugetSearchWindowSchema,
    {
      skip: url.searchParams.get("skip") ?? undefined,
      take: url.searchParams.get("take") ?? undefined,
    },
    { code: "PAGINATION_NUMBER_INVALID", message: "invalid search pagination" },
  );
}

export function allNpmSearchResultsRequest(req: Request): Request {
  const url = new URL(req.url);
  url.searchParams.set("from", "0");
  url.searchParams.set("size", String(NPM_MEMBER_SEARCH_SIZE));
  return new Request(url.toString(), { method: req.method, headers: req.headers });
}

export function allNugetSearchResultsRequest(req: Request): Request {
  const url = new URL(req.url);
  url.searchParams.set("skip", "0");
  url.searchParams.set("take", "100");
  return new Request(url.toString(), { method: req.method, headers: req.headers });
}

export function mergeNpmSearchBodies(
  bodies: Iterable<NpmSearchBody>,
  window: NpmSearchWindow,
): { objects: unknown[]; total: number } {
  const seen = new Set<string>();
  const objects: unknown[] = [];
  for (const body of bodies) {
    for (const object of body.objects ?? []) {
      const name = object.package?.name;
      if (typeof name !== "string" || seen.has(name)) continue;
      seen.add(name);
      objects.push(object);
    }
  }
  return {
    objects: objects.slice(window.from, window.from + window.size),
    total: objects.length,
  };
}

export function parseNpmSearchBody(value: unknown): NpmSearchBody | null {
  const parsed = NpmSearchBodySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseNugetSearchBody(
  text: string,
  memberMountPath: string,
  virtualMountPath: string,
): NugetSearchBody | null {
  try {
    const rewritten =
      memberMountPath === virtualMountPath
        ? text
        : text.replaceAll(`/${memberMountPath}/`, `/${virtualMountPath}/`);
    const parsed = NugetSearchBodySchema.safeParse(JSON.parse(rewritten));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function mergeNugetSearchBodies(
  bodies: Iterable<NugetSearchBody>,
  window: NugetSearchWindow,
): { data: NonNullable<NugetSearchBody["data"]>; totalHits: number } {
  const seen = new Set<string>();
  const data: NonNullable<NugetSearchBody["data"]> = [];
  for (const body of bodies) {
    for (const item of body.data ?? []) {
      const id = item.id;
      if (typeof id !== "string") continue;
      const key = id.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      data.push(item);
    }
  }
  return {
    totalHits: data.length,
    data: data.slice(window.skip, window.skip + window.take),
  };
}
