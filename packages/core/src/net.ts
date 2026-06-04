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
import { isPrivateHost } from "./private-network";

export { isPrivateHost } from "./private-network";

export type HostLookup = (hostname: string) => Promise<{ address: string }[]>;

const defaultLookup: HostLookup = (hostname) => lookup(hostname, { all: true, verbatim: true });

export interface PublicUrlOptions {
  /** Enforce public-host SSRF blocking. Defaults to true. */
  enforcePublicNetwork?: boolean;
}

/** Parse + validate a URL is an http(s) URL to a non-private host, or throw. */
export function assertPublicHttpUrl(raw: string, opts: PublicUrlOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported URL scheme: ${url.protocol}`);
  }
  if ((opts.enforcePublicNetwork ?? true) && isPrivateHost(url.hostname)) {
    throw new Error(`refusing to fetch a private/loopback/metadata host: ${url.hostname}`);
  }
  return url;
}

/**
 * Shared SSRF resolution guard: reject a private literal host, short-circuit on
 * IP literals, otherwise resolve the host and reject if any resolved address is
 * private/loopback/metadata. Returns the address to pin the connection to (the
 * literal for IP hosts, the first resolved address otherwise).
 */
async function resolvePublicAddress(url: URL, lookupHost?: HostLookup): Promise<string | null> {
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

export async function assertPublicResolvedUrl(
  url: URL,
  opts: { enforce?: boolean; lookupHost?: HostLookup } = {},
): Promise<void> {
  if (!(opts.enforce ?? true)) return;
  await resolvePublicAddress(url, opts.lookupHost);
}

async function publicResolvedAddress(
  url: URL,
  opts: { enforcePublicNetwork: boolean; lookupHost?: HostLookup },
): Promise<string | null> {
  if (!opts.enforcePublicNetwork && !opts.lookupHost) return null;
  if (!opts.enforcePublicNetwork) return null;
  return resolvePublicAddress(url, opts.lookupHost);
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
  /** Enforce public-host SSRF blocking. Defaults to true. */
  enforcePublicNetwork?: boolean;
}

/**
 * fetch() that (1) validates the target is a public http(s) URL and (2) follows
 * redirects manually, re-validating every hop so an upstream cannot redirect the
 * server into an internal/metadata address. Applies a timeout on each hop.
 */
export async function safeFetch(raw: string, opts: SafeFetchOptions = {}): Promise<Response> {
  const {
    allowedHosts,
    enforcePublicNetwork = true,
    maxHops = 3,
    timeoutMs = 30_000,
    lookupHost,
    ...init
  } = opts;
  const allowedHostSet = allowedHosts ? new Set(allowedHosts) : null;
  let url = assertPublicHttpUrl(raw, { enforcePublicNetwork });
  for (let hop = 0; hop <= maxHops; hop++) {
    if (allowedHostSet && !allowedHostSet.has(url.host)) {
      throw new Error(`redirected to disallowed host: ${url.host}`);
    }
    const address = await publicResolvedAddress(url, { enforcePublicNetwork, lookupHost });
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
      url = assertPublicHttpUrl(new URL(loc, url).toString(), { enforcePublicNetwork });
      continue;
    }
    return res;
  }
  throw new Error("too many redirects");
}
