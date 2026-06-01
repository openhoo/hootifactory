/**
 * SSRF guards for server-side fetches to upstream/proxy targets. Pull-through
 * repos and proxy passthrough fetch URLs that are influenced by repo admins and
 * by untrusted upstream JSON, so every such fetch must go through here.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isProduction } from "@hootifactory/config";

export type HostLookup = (hostname: string) => Promise<{ address: string }[]>;

const defaultLookup: HostLookup = (hostname) => lookup(hostname, { all: true, verbatim: true });

/** Literal hosts that must never be fetched server-side (loopback, RFC1918, link-local, metadata, ULA). */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (h.startsWith("::ffff:")) return isPrivateHost(h.slice("::ffff:".length));
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (
    h === "::1" ||
    h === "::" ||
    h.startsWith("fe80:") ||
    h.startsWith("fc") ||
    h.startsWith("fd") ||
    h.startsWith("ff")
  ) {
    return true;
  }
  // IPv4 literal ranges
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 10 || a === 0) return true; // loopback / private / "this host"
    if (a === 169 && b === 254) return true; // link-local + cloud metadata (169.254.169.254)
    if (a === 192 && b === 168) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmark networks
    if (a >= 224) return true; // multicast/reserved
  }
  return false;
}

/** Parse + validate a URL is an http(s) URL to a non-private host, or throw. */
export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported URL scheme: ${url.protocol}`);
  }
  // The private-host block is enforced in production (the multi-tenant SSRF
  // threat). In dev/test, proxying to a local/internal registry is a normal,
  // intended workflow, so it is allowed.
  if (isProduction && isPrivateHost(url.hostname)) {
    throw new Error(`refusing to fetch a private/loopback/metadata host: ${url.hostname}`);
  }
  return url;
}

export async function assertPublicResolvedUrl(
  url: URL,
  opts: { enforce?: boolean; lookupHost?: HostLookup } = {},
): Promise<void> {
  if (!(opts.enforce ?? isProduction)) return;
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isPrivateHost(hostname)) {
    throw new Error(`refusing to fetch a private/loopback/metadata host: ${url.hostname}`);
  }
  if (isIP(hostname) !== 0) return;
  const addresses = await (opts.lookupHost ?? defaultLookup)(hostname);
  if (addresses.length === 0) throw new Error(`could not resolve upstream host: ${hostname}`);
  const blocked = addresses.find((a) => isPrivateHost(a.address));
  if (blocked) {
    throw new Error(
      `refusing to fetch ${hostname}; DNS resolved to private/loopback/metadata address ${blocked.address}`,
    );
  }
}

export interface SafeFetchOptions extends RequestInit {
  /** Max redirect hops to follow (each re-validated). Default 3. */
  maxHops?: number;
  /** Per-request timeout in ms. Default 30s. */
  timeoutMs?: number;
  /** Test hook for DNS-resolution SSRF checks. */
  lookupHost?: HostLookup;
}

/**
 * fetch() that (1) validates the target is a public http(s) URL and (2) follows
 * redirects manually, re-validating every hop so an upstream cannot redirect the
 * server into an internal/metadata address. Applies a timeout on each hop.
 */
export async function safeFetch(raw: string, opts: SafeFetchOptions = {}): Promise<Response> {
  const { maxHops = 3, timeoutMs = 30_000, lookupHost, ...init } = opts;
  let url = assertPublicHttpUrl(raw);
  for (let hop = 0; hop <= maxHops; hop++) {
    await assertPublicResolvedUrl(url, { lookupHost });
    const res = await fetch(url, {
      ...init,
      redirect: "manual",
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      url = assertPublicHttpUrl(new URL(loc, url).toString());
      continue;
    }
    return res;
  }
  throw new Error("too many redirects");
}
