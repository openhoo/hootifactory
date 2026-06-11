import { env } from "@hootifactory/config";

/**
 * Opt-in breached-password screening against the Have I Been Pwned range API
 * using k-anonymity: the password is SHA-1 hashed locally and only the first
 * five hex characters of the digest are sent upstream; the returned suffix
 * list is matched on this host. Neither the password nor its full hash ever
 * leaves the process.
 *
 * The check FAILS OPEN: any network error, timeout, or unexpected response is
 * treated as "not breached" so a HIBP outage can never block registrations or
 * password changes. Callers that want visibility into skipped checks should
 * pass `onCheckFailure` and log a warning.
 */

const HIBP_RANGE_ENDPOINT = "https://api.pwnedpasswords.com/range";
const DEFAULT_TIMEOUT_MS = 3_000;

/** User-facing rejection message. Deliberately omits the breach count. */
export const BREACHED_PASSWORD_MESSAGE =
  "this password appears in known data breaches; choose a different one";

export interface BreachedPasswordCheckDeps {
  /** Injectable fetch for tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Overrides env.AUTH_BREACHED_PASSWORD_CHECK (the check is opt-in). */
  enabled?: boolean;
  /** Upstream timeout in milliseconds. Defaults to 3000. */
  timeoutMs?: number;
  /** Invoked when the upstream check fails and the password is allowed through. */
  onCheckFailure?: (error: unknown) => void;
}

function sha1HexUpper(input: string): string {
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(input);
  return hasher.digest("hex").toUpperCase();
}

/**
 * Returns true when the password's SHA-1 suffix appears in the HIBP range
 * response with a non-zero count (padding entries report a count of 0).
 * Returns false when the check is disabled or the upstream call fails.
 */
export async function isBreachedPassword(
  password: string,
  deps: BreachedPasswordCheckDeps = {},
): Promise<boolean> {
  const enabled = deps.enabled ?? env.AUTH_BREACHED_PASSWORD_CHECK;
  if (!enabled) return false;

  const doFetch = deps.fetch ?? fetch;
  const digest = sha1HexUpper(password);
  const prefix = digest.slice(0, 5);
  const suffix = digest.slice(5);
  try {
    const response = await doFetch(`${HIBP_RANGE_ENDPOINT}/${prefix}`, {
      headers: {
        // Pads every response to ~800-1000 entries so response size cannot
        // leak which prefix bucket was queried.
        "Add-Padding": "true",
      },
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`unexpected HIBP response status ${response.status}`);
    const body = await response.text();
    for (const line of body.split("\n")) {
      const [hashSuffix, count] = line.trim().split(":");
      if (hashSuffix?.toUpperCase() === suffix) return Number(count) > 0;
    }
    return false;
  } catch (error) {
    deps.onCheckFailure?.(error);
    return false;
  }
}
