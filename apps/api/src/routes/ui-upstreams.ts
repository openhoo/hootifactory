import { assertPublicHttpUrl } from "@hootifactory/core";
import type { RepositoryRow } from "./ui-repository-access";

type ProxyUpstreamRepo = Pick<RepositoryRow, "kind">;
type UrlValidator = (url: string) => URL;

type ValidationResult = { ok: true } | { ok: false; status: 400; error: string };

type UpstreamUrlResult = { ok: true; url: string } | { ok: false; status: 400; error: string };

export function validateProxyUpstreamParent(parent: ProxyUpstreamRepo): ValidationResult {
  if (parent.kind !== "proxy") {
    return {
      ok: false,
      status: 400,
      error: "upstreams can only be added to proxy repositories",
    };
  }
  return { ok: true };
}

export function validateProxyUpstreamUrl(
  url: string,
  validateUrl: UrlValidator = assertPublicHttpUrl,
): UpstreamUrlResult {
  try {
    validateUrl(url);
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: err instanceof Error ? err.message : "invalid upstream url",
    };
  }
  return { ok: true, url };
}
