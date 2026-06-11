/**
 * SSRF guards for server-side fetches to upstream/proxy targets. Pull-through
 * repos and proxy passthrough fetch URLs that are influenced by repo admins and
 * by untrusted upstream JSON, so every such fetch must go through here.
 */

import { Buffer } from "node:buffer";
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
    throw new Error(`invalid URL: ${redactUrlCredentials(raw)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported URL scheme: ${url.protocol}`);
  }
  if ((opts.enforcePublicNetwork ?? true) && isPrivateHost(url.hostname)) {
    throw new Error(`refusing to fetch a private/loopback/metadata host: ${url.hostname}`);
  }
  return url;
}

/** Strip any userinfo (`user:pass@`) from a URL so it is safe for logs/telemetry. */
export function redactUrlCredentials(raw: string): string {
  try {
    const url = new URL(raw);
    if (!url.username && !url.password) return raw;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    // Unparseable input: strip any `//userinfo@` segment textually so even a
    // malformed URL cannot carry credentials into logs.
    return raw.replace(/\/\/[^/@\s]*@/g, "//");
  }
}

/**
 * Copy userinfo credentials from `base` onto `target` when `target` carries none
 * and points at the same host. Proxy plugins fetch secondary URLs advertised by
 * untrusted upstream JSON (tarballs, version documents) that they already pin to
 * the configured upstream host; this lets those fetches reuse the upstream's
 * credentials without ever sending them to a third-party host.
 */
export function inheritUrlCredentials(target: string, base: string): string {
  try {
    const targetUrl = new URL(target);
    const baseUrl = new URL(base);
    if (!baseUrl.username && !baseUrl.password) return target;
    if (targetUrl.username || targetUrl.password) return target;
    if (targetUrl.host !== baseUrl.host) return target;
    // Userinfo round-trips in percent-encoded form: the getters return the
    // encoded value and `%` is not re-encoded by the setters.
    targetUrl.username = baseUrl.username;
    targetUrl.password = baseUrl.password;
    return targetUrl.toString();
  } catch {
    return target;
  }
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

function stripUrlCredentials(url: URL): void {
  url.username = "";
  url.password = "";
}

function basicAuthorization(url: URL): string {
  const decode = (value: string) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  return `Basic ${Buffer.from(`${decode(url.username)}:${decode(url.password)}`, "utf8").toString("base64")}`;
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
 * fetch() that (1) validates the target is a public http(s) URL, (2) follows
 * redirects manually, re-validating every hop so an upstream cannot redirect the
 * server into an internal/metadata address, and (3) lifts URL userinfo into a
 * Basic Authorization header sent only to the origin that carried the
 * credentials — never replayed across a cross-origin redirect. Applies a
 * timeout on each hop.
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
  // Userinfo credentials are lifted out of the URL and forwarded explicitly as a
  // Basic Authorization header, only on hops to the origin that carried them.
  // Bun's fetch silently drops URL userinfo while node's http.request forwards
  // it implicitly, and a redirect must never replay credentials cross-origin.
  const auth =
    url.username || url.password ? { origin: url.origin, header: basicAuthorization(url) } : null;
  stripUrlCredentials(url);
  for (let hop = 0; hop <= maxHops; hop++) {
    if (allowedHostSet && !allowedHostSet.has(url.host)) {
      throw new Error(`redirected to disallowed host: ${url.host}`);
    }
    const address = await publicResolvedAddress(url, { enforcePublicNetwork, lookupHost });
    const headers = new Headers(init.headers);
    if (auth && url.origin === auth.origin && !headers.has("authorization")) {
      headers.set("authorization", auth.header);
    }
    const requestInit = {
      ...init,
      headers,
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
      // A redirect target never contributes credentials of its own.
      stripUrlCredentials(url);
      // Drain the redirect body so the pinned-fetch socket is released now rather
      // than lingering until the per-hop timeout fires.
      await res.body?.cancel().catch(() => {});
      continue;
    }
    return res;
  }
  throw new Error("too many redirects");
}
