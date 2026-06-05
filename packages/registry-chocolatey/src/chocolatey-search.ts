import { Errors } from "@hootifactory/registry";
import { unquoteODataLiteral } from "./chocolatey-validation";

export interface ChocolateySearchQuery {
  /** Lower-cased substring to match against id/title. */
  term: string;
  includePrerelease: boolean;
  skip: number;
  top: number;
}

const MAX_SKIP = 100_000;
const MAX_TOP = 100;
const DEFAULT_TOP = 30;

/** Parse a `Search()` query string into normalized paging + filter options. */
export function parseChocolateySearchQuery(url: string): ChocolateySearchQuery {
  const params = new URL(url).searchParams;
  return {
    term: unquoteODataLiteral(params.get("searchTerm")).trim().toLowerCase(),
    includePrerelease: (params.get("includePrerelease") ?? "").toLowerCase() === "true",
    skip: boundedInteger(params.get("$skip"), { fallback: 0, min: 0, max: MAX_SKIP }),
    top: boundedInteger(params.get("$top"), { fallback: DEFAULT_TOP, min: 0, max: MAX_TOP }),
  };
}

function boundedInteger(
  value: string | null,
  opts: { fallback: number; min: number; max: number },
): number {
  if (value === null || value === "") return opts.fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < opts.min) {
    throw Errors.paginationNumberInvalid();
  }
  return Math.min(parsed, opts.max);
}
