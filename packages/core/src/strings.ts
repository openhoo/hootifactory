/**
 * Small string-normalization helpers shared across packages.
 *
 * These are plain linear scans rather than the obvious anchored regexes
 * (`/^-+|-+$/`, `/^\/+/`, `/\/+$/`) because CodeQL flags an end-anchored
 * quantifier (`X+$`) as polynomial ReDoS: it backtracks O(n^2) on a long run
 * of `X` followed by a non-matching character. A single pass from each end
 * avoids that while producing identical results.
 */

/** Trim every leading and trailing occurrence of `ch` (a single character). */
export function trimChar(value: string, ch: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === ch) start++;
  while (end > start && value[end - 1] === ch) end--;
  return value.slice(start, end);
}

/**
 * Strip trailing slashes from an optional URL/path, preserving the input's
 * nullishness so callers can keep their `|| fallback` idiom (`undefined` and
 * `""` flow straight through).
 */
export function stripTrailingSlashes(value: string | undefined): string | undefined {
  if (!value) return value;
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end--;
  return value.slice(0, end);
}
