import { TOKEN_PREFIX } from "@hootifactory/auth";
import { z } from "@hootifactory/core";

const AuthorizationHeaderSchema = z.string().trim().min(1).max(16_384);
const RegistryApiKeyHeaderSchema = z.string().trim().min(1).max(4096);
const basicAuthDecoder = new TextDecoder("utf-8", { fatal: true });

export type ParsedAuthorizationHeader =
  | { kind: "bearer"; token: string }
  | { kind: "basic"; username: string; password: string }
  | { kind: "bareToken"; token: string }
  | { kind: "invalid" };

export type ParsedRegistryApiKeyHeader = { kind: "token"; token: string } | { kind: "invalid" };

export function decodeBasicCredentials(value: string): string | null {
  try {
    const binary = atob(value.trim());
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return basicAuthDecoder.decode(bytes);
  } catch {
    return null;
  }
}

export function parseAuthorizationHeader(
  rawAuthz: string | null | undefined,
): ParsedAuthorizationHeader | null {
  if (rawAuthz == null) return null;
  const parsedAuthz = AuthorizationHeaderSchema.safeParse(rawAuthz);
  if (!parsedAuthz.success) return { kind: "invalid" };
  const authz = parsedAuthz.data;
  // RFC 7235/6750/7617: the auth-scheme token is case-insensitive. Split the
  // scheme from its credentials on the first whitespace run and compare it
  // lowercased, while preserving the original credential bytes (Basic base64
  // and Bearer token values must not be lowercased).
  const schemeMatch = /^(\S+)\s+([\s\S]*)$/.exec(authz);
  if (schemeMatch) {
    const [, schemeToken = "", credentials = ""] = schemeMatch;
    const scheme = schemeToken.toLowerCase();
    if (scheme === "bearer") {
      return { kind: "bearer", token: credentials.trim() };
    }
    if (scheme === "basic") {
      const decoded = decodeBasicCredentials(credentials);
      if (!decoded) return { kind: "invalid" };
      const idx = decoded.indexOf(":");
      if (idx < 0) return { kind: "invalid" };
      return {
        kind: "basic",
        username: decoded.slice(0, idx),
        password: decoded.slice(idx + 1),
      };
    }
  }
  if (authz.startsWith(TOKEN_PREFIX)) {
    return { kind: "bareToken", token: authz.trim() };
  }
  return { kind: "invalid" };
}

export function parseRegistryApiKeyHeader(
  rawApiKey: string | null | undefined,
): ParsedRegistryApiKeyHeader | null {
  if (rawApiKey == null) return null;
  const parsedApiKey = RegistryApiKeyHeaderSchema.safeParse(rawApiKey);
  if (!parsedApiKey.success) return { kind: "invalid" };
  const apiKey = parsedApiKey.data;
  if (!apiKey.startsWith(TOKEN_PREFIX)) return { kind: "invalid" };
  return { kind: "token", token: apiKey.trim() };
}
