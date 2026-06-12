import { isIP } from "node:net";
import { env } from "@hootifactory/config";
import type { Context } from "hono";
import type { AppEnv } from "./types";

export const UNKNOWN_CLIENT_IP = "unknown";

interface ParsedIp {
  family: 4 | 6;
  /** 4 bytes for IPv4, 16 bytes for IPv6 (network order). */
  bytes: Uint8Array;
}

export interface TrustedProxyRange {
  family: 4 | 6;
  bytes: Uint8Array;
  prefixBits: number;
}

/**
 * Compile operator-supplied trusted-proxy entries (plain IPs or CIDR ranges)
 * once so per-request matching is a cheap prefix comparison. Entries that do
 * not parse are skipped; `API_TRUSTED_PROXIES` is validated at startup, so a
 * skip can only happen for hand-built lists in tests.
 */
export function compileTrustedProxies(entries: readonly string[]): TrustedProxyRange[] {
  const ranges: TrustedProxyRange[] = [];
  for (const entry of entries) {
    const range = parseProxyRange(entry);
    if (range) ranges.push(range);
  }
  return ranges;
}

export interface ClientIpSources {
  /** The transport-level peer address (socket remote address), if known. */
  peerAddress: string | null | undefined;
  /** The raw `x-forwarded-for` header value, if present. */
  forwardedFor: string | null | undefined;
  trustedProxies: readonly TrustedProxyRange[];
}

/**
 * Resolve the client IP using the standard trusted-proxy algorithm:
 *
 * - No peer address available: "unknown".
 * - Peer is not a trusted proxy: the peer IS the client; `x-forwarded-for`
 *   is attacker-controlled input and is never consulted.
 * - Peer is a trusted proxy: walk `x-forwarded-for` right-to-left, skipping
 *   trusted hops; the first untrusted address is the client. A malformed hop
 *   reached during the walk yields "unknown" rather than misattributing, and
 *   if every hop is trusted (or the header is absent) the peer is reported.
 */
export function resolveClientIp(sources: ClientIpSources): string {
  const peer = parseCandidate(sources.peerAddress);
  if (!peer) return UNKNOWN_CLIENT_IP;
  if (!isTrusted(peer, sources.trustedProxies)) return formatIp(peer);

  const header = sources.forwardedFor?.trim() ?? "";
  if (header) {
    const hops = header.split(",");
    for (let i = hops.length - 1; i >= 0; i--) {
      const candidate = parseCandidate(hops[i]);
      if (!candidate) return UNKNOWN_CLIENT_IP;
      if (!isTrusted(candidate, sources.trustedProxies)) return formatIp(candidate);
    }
  }
  return formatIp(peer);
}

let envTrustedProxies: TrustedProxyRange[] | undefined;

function trustedProxiesFromEnv(): readonly TrustedProxyRange[] {
  envTrustedProxies ??= compileTrustedProxies(env.API_TRUSTED_PROXIES);
  return envTrustedProxies;
}

/**
 * The client IP for a request: the direct socket peer (from Bun's
 * `server.requestIP`), or the right-most untrusted `x-forwarded-for` hop when
 * the peer is one of the `API_TRUSTED_PROXIES`. Returns "unknown" when no
 * transport information is available (e.g. `app.request()` in tests).
 */
export function clientIp(
  c: Context<AppEnv>,
  trustedProxies: readonly TrustedProxyRange[] = trustedProxiesFromEnv(),
): string {
  return resolveClientIp({
    peerAddress: peerAddress(c),
    forwardedFor: c.req.header("x-forwarded-for"),
    trustedProxies,
  });
}

/** `clientIp`, but with "unknown" mapped to `undefined` for optional columns. */
export function clientIpOrUndefined(c: Context<AppEnv>): string | undefined {
  const ip = clientIp(c);
  return ip === UNKNOWN_CLIENT_IP ? undefined : ip;
}

interface BunServerLike {
  requestIP: (request: Request) => { address?: unknown } | null;
}

function asBunServer(value: unknown): BunServerLike | undefined {
  if (
    value &&
    typeof value === "object" &&
    typeof (value as BunServerLike).requestIP === "function"
  ) {
    return value as BunServerLike;
  }
  return undefined;
}

/**
 * The socket peer address. `Bun.serve({ fetch: app.fetch })` passes the server
 * as the second `fetch` argument, which Hono exposes as `c.env`; a nested
 * `{ server }` binding is also supported for embedders that wrap the env.
 */
function peerAddress(c: Context<AppEnv>): string | null {
  const binding: unknown = c.env;
  const server =
    asBunServer(binding) ?? asBunServer((binding as { server?: unknown } | undefined)?.server);
  if (!server) return null;
  try {
    const address = server.requestIP(c.req.raw)?.address;
    return typeof address === "string" ? address : null;
  } catch {
    return null;
  }
}

function isTrusted(ip: ParsedIp, ranges: readonly TrustedProxyRange[]): boolean {
  return ranges.some((range) => rangeContains(range, ip));
}

function rangeContains(range: TrustedProxyRange, ip: ParsedIp): boolean {
  if (range.family !== ip.family) return false;
  for (let i = 0, bits = range.prefixBits; bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if (((ip.bytes[i] ?? 0) & mask) !== ((range.bytes[i] ?? 0) & mask)) return false;
  }
  return true;
}

function parseProxyRange(entry: string): TrustedProxyRange | null {
  const text = entry.trim();
  const slash = text.indexOf("/");
  if (slash < 0) {
    const ip = parseCandidate(text);
    return ip
      ? { family: ip.family, bytes: ip.bytes, prefixBits: ip.family === 4 ? 32 : 128 }
      : null;
  }
  const base = parseIp(text.slice(0, slash));
  if (!base) return null;
  const prefixText = text.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixText)) return null;
  const prefixBits = Number(prefixText);
  if (prefixBits > (base.family === 4 ? 32 : 128)) return null;

  const normalized = normalizeMapped(base);
  if (normalized && normalized.family === 4 && prefixBits >= 96) {
    const v4Prefix = prefixBits - 96;
    if (v4Prefix > 32) return null;
    return { family: 4, bytes: normalized.bytes, prefixBits: v4Prefix };
  }

  return { family: base.family, bytes: base.bytes, prefixBits };
}

/**
 * Parse a single address candidate (socket peer or one `x-forwarded-for` hop).
 * Tolerates the textual forms proxies emit — `[v6]`, `[v6]:port`, `v4:port`,
 * and zone-scoped link-local addresses — and normalizes IPv4-mapped IPv6 to
 * plain IPv4 so the result matches operator config and throttle keys.
 */
function parseCandidate(raw: string | null | undefined): ParsedIp | null {
  let text = raw?.trim() ?? "";
  if (!text) return null;
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    if (end < 0) return null;
    const rest = text.slice(end + 1);
    if (rest !== "" && !/^:\d{1,5}$/.test(rest)) return null;
    text = text.slice(1, end);
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(text)) {
    text = text.slice(0, text.lastIndexOf(":"));
  }
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  return normalizeMapped(parseIp(text));
}

function parseIp(text: string): ParsedIp | null {
  const family = isIP(text);
  if (family === 4) return { family: 4, bytes: ipv4Bytes(text) };
  if (family === 6) return { family: 6, bytes: ipv6Bytes(text) };
  return null;
}

/** Collapse an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) to plain IPv4. */
function normalizeMapped(ip: ParsedIp | null): ParsedIp | null {
  if (!ip || ip.family === 4) return ip;
  for (let i = 0; i < 10; i++) {
    if (ip.bytes[i] !== 0) return ip;
  }
  if (ip.bytes[10] !== 0xff || ip.bytes[11] !== 0xff) return ip;
  return { family: 4, bytes: ip.bytes.slice(12) };
}

function ipv4Bytes(text: string): Uint8Array {
  const parts = text.split(".");
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) bytes[i] = Number(parts[i] ?? "0");
  return bytes;
}

/** Expand an `isIP`-validated IPv6 textual form into its 16 bytes. */
function ipv6Bytes(text: string): Uint8Array {
  const gap = text.indexOf("::");
  const head = gap >= 0 ? text.slice(0, gap) : text;
  const tail = gap >= 0 ? text.slice(gap + 2) : "";
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];

  // An embedded IPv4 suffix (e.g. ::ffff:192.0.2.1) occupies the final two groups.
  const target = gap < 0 ? headGroups : tailGroups;
  const last = target.at(-1);
  if (last?.includes(".")) {
    const v4 = ipv4Bytes(last);
    target.splice(
      -1,
      1,
      (((v4[0] ?? 0) << 8) | (v4[1] ?? 0)).toString(16),
      (((v4[2] ?? 0) << 8) | (v4[3] ?? 0)).toString(16),
    );
  }

  const missing = Math.max(8 - headGroups.length - tailGroups.length, 0);
  const groups = [...headGroups, ...Array<string>(missing).fill("0"), ...tailGroups];
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const value = Number.parseInt(groups[i] ?? "0", 16);
    bytes[i * 2] = (value >> 8) & 0xff;
    bytes[i * 2 + 1] = value & 0xff;
  }
  return bytes;
}

function formatIp(ip: ParsedIp): string {
  if (ip.family === 4) return Array.from(ip.bytes).join(".");
  return formatIpv6(ip.bytes);
}

/** Canonical (RFC 5952) IPv6 text: lowercase, longest zero run compressed. */
function formatIpv6(bytes: Uint8Array): string {
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0));

  let bestStart = -1;
  let bestLength = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLength) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }

  const hex = (values: number[]) => values.map((value) => value.toString(16)).join(":");
  if (bestLength < 2) return hex(groups);
  return `${hex(groups.slice(0, bestStart))}::${hex(groups.slice(bestStart + bestLength))}`;
}
