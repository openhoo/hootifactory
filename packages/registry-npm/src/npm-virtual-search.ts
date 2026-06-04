import { Errors } from "@hootifactory/registry";

interface NpmSearchBody {
  objects?: Array<{ package?: { name?: unknown }; [key: string]: unknown }>;
  total?: number;
  [key: string]: unknown;
}

const NPM_MEMBER_SEARCH_SIZE = 250;

export function npmSearchWindow(req: Request): { from: number; size: number } {
  const url = new URL(req.url);
  return {
    from: boundedSearchInteger(url.searchParams.get("from"), { fallback: 0, min: 0, max: 10_000 }),
    size: boundedSearchInteger(url.searchParams.get("size"), { fallback: 20, min: 0, max: 100 }),
  };
}

export function allNpmSearchResultsRequest(req: Request): Request {
  const url = new URL(req.url);
  url.searchParams.set("from", "0");
  url.searchParams.set("size", String(NPM_MEMBER_SEARCH_SIZE));
  return new Request(url.toString(), { method: req.method, headers: req.headers });
}

export function parseNpmSearchBody(value: unknown): NpmSearchBody | null {
  if (!value || typeof value !== "object") return null;
  const body = value as NpmSearchBody;
  if (!Array.isArray(body.objects)) return null;
  if (body.total !== undefined && typeof body.total !== "number") return null;
  return body;
}

export function mergeNpmSearchBodies(
  bodies: Iterable<NpmSearchBody | null>,
  window: { from: number; size: number },
): { objects: unknown[]; total: number } {
  const seen = new Set<string>();
  const objects: unknown[] = [];
  for (const body of bodies) {
    for (const object of body?.objects ?? []) {
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

function boundedSearchInteger(
  value: string | null,
  opts: { fallback: number; min: number; max: number },
): number {
  if (value === null) return opts.fallback;
  const parsed = Number(value ?? opts.fallback);
  if (
    !Number.isFinite(parsed) ||
    !Number.isInteger(parsed) ||
    parsed < opts.min ||
    parsed > opts.max
  ) {
    throw Errors.paginationNumberInvalid();
  }
  return parsed;
}
