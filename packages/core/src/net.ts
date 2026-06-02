/**
 * SSRF guards for server-side fetches to upstream/proxy targets. Pull-through
 * repos and proxy passthrough fetch URLs that are influenced by repo admins and
 * by untrusted upstream JSON, so every such fetch must go through here.
 */

import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { isProduction } from "@hootifactory/config";

export type HostLookup = (hostname: string) => Promise<{ address: string }[]>;

const defaultLookup: HostLookup = (hostname) => lookup(hostname, { all: true, verbatim: true });

function parseIPv4Literal(hostname: string): number[] | null {
  const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  if (octets.some((n) => n > 255)) return null;
  return octets;
}

function expandIPv6Literal(hostname: string): number[] | null {
  if (isIP(hostname) !== 6) return null;
  let h = hostname;
  const dotted = h.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const octets = parseIPv4Literal(dotted[2]!);
    if (!octets) return null;
    const high = (octets[0]! << 8) | octets[1]!;
    const low = (octets[2]! << 8) | octets[3]!;
    h = `${dotted[1]}${high.toString(16)}:${low.toString(16)}`;
  }

  const compressed = h.split("::");
  if (compressed.length > 2) return null;
  const left = compressed[0] ? compressed[0].split(":") : [];
  const right = compressed.length === 2 && compressed[1] ? compressed[1].split(":") : [];
  const explicit = [...left, ...right];
  if (explicit.some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return null;
  const zeros = compressed.length === 2 ? 8 - explicit.length : 0;
  if (zeros < 0 || (compressed.length === 1 && explicit.length !== 8)) return null;
  return [
    ...left.map((part) => Number.parseInt(part, 16)),
    ...Array.from({ length: zeros }, () => 0),
    ...right.map((part) => Number.parseInt(part, 16)),
  ];
}

function ipv6Bytes(hextets: number[]): number[] {
  return hextets.flatMap((hextet) => [(hextet >> 8) & 0xff, hextet & 0xff]);
}

function bytesStartWith(bytes: number[], prefix: number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

function ipv4StringFromBytes(bytes: number[]): string {
  return `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
}

function rfc6052EmbeddedIPv4(bytes: number[], prefixLength: 32 | 40 | 48 | 56 | 64 | 96): string {
  if (prefixLength === 96) return ipv4StringFromBytes(bytes.slice(12, 16));
  const withoutReservedOctet = [...bytes.slice(0, 8), ...bytes.slice(9)];
  const start = prefixLength / 8;
  return ipv4StringFromBytes(withoutReservedOctet.slice(start, start + 4));
}

function embeddedIPv4Host(hextets: number[]): string | null {
  const bytes = ipv6Bytes(hextets);
  if (bytesStartWith(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff])) {
    return ipv4StringFromBytes(bytes.slice(12, 16));
  }
  if (bytesStartWith(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])) {
    return ipv4StringFromBytes(bytes.slice(12, 16));
  }
  if (bytesStartWith(bytes, [0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0])) {
    return rfc6052EmbeddedIPv4(bytes, 96);
  }
  if (bytesStartWith(bytes, [0, 0x64, 0xff, 0x9b, 0, 1])) {
    return rfc6052EmbeddedIPv4(bytes, 48);
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return ipv4StringFromBytes(bytes.slice(2, 6));
  }
  return null;
}

/** Literal hosts that must never be fetched server-side (loopback, RFC1918, link-local, metadata, ULA). */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (h === "localhost" || h.endsWith(".localhost")) return true;

  // IPv4 literal ranges
  const looksLikeIPv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(h);
  const octets = parseIPv4Literal(h);
  if (looksLikeIPv4 && !octets) return true;
  if (octets) {
    const [a, b] = [octets[0]!, octets[1]!];
    if (a === 127 || a === 10 || a === 0) return true; // loopback / private / "this host"
    if (a === 169 && b === 254) return true; // link-local + cloud metadata (169.254.169.254)
    if (a === 192 && b === 168) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmark networks
    if (a >= 224) return true; // multicast/reserved
    return false;
  }

  const hextets = expandIPv6Literal(h);
  if (!hextets) return false;
  const first = hextets[0]!;
  if (
    h === "::1" ||
    h === "::" ||
    (first >= 0xfe80 && first <= 0xfebf) ||
    (first >= 0xfec0 && first <= 0xfeff) ||
    (first >= 0xfc00 && first <= 0xfdff) ||
    (first >= 0xff00 && first <= 0xffff)
  ) {
    return true;
  }
  const embedded = embeddedIPv4Host(hextets);
  if (embedded) return isPrivateHost(embedded);
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

async function publicResolvedAddress(url: URL, lookupHost?: HostLookup): Promise<string | null> {
  if (!isProduction && !lookupHost) return null;
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isPrivateHost(hostname)) {
    throw new Error(`refusing to fetch a private/loopback/metadata host: ${url.hostname}`);
  }
  if (isIP(hostname) !== 0) return hostname;
  const addresses = await (lookupHost ?? defaultLookup)(hostname);
  if (addresses.length === 0) throw new Error(`could not resolve upstream host: ${hostname}`);
  const blocked = addresses.find((a) => isPrivateHost(a.address));
  if (blocked) {
    throw new Error(
      `refusing to fetch ${hostname}; DNS resolved to private/loopback/metadata address ${blocked.address}`,
    );
  }
  return addresses[0]?.address ?? null;
}

function headersInit(init?: RequestInit["headers"]): Record<string, string> {
  const headers = new Headers(init);
  const out: Record<string, string> = {};
  for (const [key, value] of headers) out[key] = value;
  return out;
}

async function pinnedFetch(
  url: URL,
  address: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
  const method = init.method ?? "GET";
  const headers = headersInit(init.headers);
  const body = init.body;
  if (!headers.host) headers.host = url.host;

  return new Promise<Response>((resolve, reject) => {
    const req = transport(
      url,
      {
        method,
        headers,
        lookup: (_hostname, _options, cb) => {
          cb(null, address, isIP(address) || 4);
        },
        signal: init.signal ?? undefined,
      },
      (res) => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          if (Array.isArray(value)) {
            for (const item of value) responseHeaders.append(key, item);
          } else {
            responseHeaders.set(key, value);
          }
        }
        resolve(
          new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, {
            status: res.statusCode ?? 0,
            statusText: res.statusMessage,
            headers: responseHeaders,
          }),
        );
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`fetch timed out after ${timeoutMs}ms`)));
    req.on("error", reject);
    if (typeof body === "string" || body instanceof Uint8Array) {
      req.end(body);
    } else if (body instanceof ArrayBuffer) {
      req.end(new Uint8Array(body));
    } else if (body == null) {
      req.end();
    } else {
      reject(new TypeError("safeFetch: unsupported request body for pinned fetch"));
      req.destroy();
    }
  });
}

export interface SafeFetchOptions extends RequestInit {
  /** Optional host allowlist (host includes port) enforced on the initial URL and every redirect. */
  allowedHosts?: string[];
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
  const { allowedHosts, maxHops = 3, timeoutMs = 30_000, lookupHost, ...init } = opts;
  const allowedHostSet = allowedHosts ? new Set(allowedHosts) : null;
  let url = assertPublicHttpUrl(raw);
  for (let hop = 0; hop <= maxHops; hop++) {
    if (allowedHostSet && !allowedHostSet.has(url.host)) {
      throw new Error(`redirected to disallowed host: ${url.host}`);
    }
    const address = await publicResolvedAddress(url, lookupHost);
    const requestInit = {
      ...init,
      redirect: "manual" as const,
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    };
    const res = address
      ? await pinnedFetch(url, address, requestInit, timeoutMs)
      : await fetch(url, requestInit);
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
