import { RegistryError, zodIssueTree } from "@hootifactory/core";
import type {
  RegistryRouteParamErrorOptions,
  RegistryRouteParamInput,
  RegistryRouteParamSpec,
  RegistryRouteParamsShape,
} from "./route-types";

function resolveParamSpec(input: RegistryRouteParamInput): RegistryRouteParamSpec {
  return typeof (input as { safeParse?: unknown }).safeParse === "function"
    ? { schema: input as RegistryRouteParamSpec["schema"] }
    : (input as RegistryRouteParamSpec);
}

/**
 * Merge route-level error defaults under each param's own overrides, so
 * `.params(shape, { code, message })` keeps a plugin's per-format error
 * vocabulary without repeating it per param.
 */
export function registryRouteParamDefaults<Params extends Record<string, string>>(
  shape: RegistryRouteParamsShape<Params>,
  defaults: RegistryRouteParamErrorOptions,
): RegistryRouteParamsShape<Params> {
  const merged: Record<string, RegistryRouteParamSpec> = {};
  for (const [name, input] of Object.entries(shape)) {
    if (!input) continue;
    merged[name] = { ...defaults, ...resolveParamSpec(input as RegistryRouteParamInput) };
  }
  return merged as RegistryRouteParamsShape<Params>;
}

/**
 * Validate `match.params` against a route's declared param schemas, in shape
 * declaration order. Failures raise the exact `RegistryError` shape
 * `parseRegistryInput` raises (status 400 / code "UNSUPPORTED" / message
 * "invalid request" unless overridden, detail = zod issue tree), so converted
 * plugins keep byte-identical error responses. Returns the params record with
 * each validated param replaced by its schema output (normalized values flow
 * to both the permission resolver and the handler); untouched params and
 * routes without schemas pass through unchanged.
 */
export function validateRegistryRouteParams(
  shape: RegistryRouteParamsShape | undefined,
  params: Record<string, string>,
): Record<string, string> {
  if (!shape) return params;
  let validated: Record<string, string> | undefined;
  for (const [name, input] of Object.entries(shape)) {
    if (!input) continue;
    const spec = resolveParamSpec(input as RegistryRouteParamInput);
    const parsed = spec.schema.safeParse(params[name]);
    if (!parsed.success) {
      throw new RegistryError(
        spec.status ?? 400,
        spec.code ?? "UNSUPPORTED",
        spec.message ?? "invalid request",
        zodIssueTree(parsed.error),
      );
    }
    if (parsed.data !== params[name]) {
      validated ??= { ...params };
      validated[name] = parsed.data;
    }
  }
  return validated ?? params;
}
