import { env } from "@hootifactory/config";
import { assertPublicHttpUrl } from "@hootifactory/core";
import type { ResolvedRepo } from "@hootifactory/registry";

type ProxyUpstreamRepo = Pick<ResolvedRepo, "kind">;
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
  validateUrl: UrlValidator = (value) =>
    assertPublicHttpUrl(value, {
      enforcePublicNetwork: !env.REGISTRY_ALLOW_PRIVATE_UPSTREAMS,
    }),
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
