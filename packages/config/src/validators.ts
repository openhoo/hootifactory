import { isIP } from "node:net";
import { z } from "zod";

/**
 * Coerce common boolean string env values, case-insensitively. Unrecognized
 * values fail loudly (rather than silently defaulting to false) so a typo like
 * `SCANNER_ENABLED=ture` is a startup error, not a silent security no-op.
 */
export const boolish = z.union([z.boolean(), z.string()]).transform((v, ctx) => {
  if (typeof v === "boolean") return v;
  const s = v.trim().toLowerCase();
  if (["true", "1", "yes", "on", "y"].includes(s)) return true;
  if (["false", "0", "no", "off", "n", ""].includes(s)) return false;
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: `expected a boolean, got "${v}"` });
  return z.NEVER;
});

/** An absolute URL (any scheme). Trailing slashes are stripped for safe joins. */
export const absoluteUrl = z
  .string()
  .url()
  .transform((s) => s.replace(/\/+$/, ""));

export const httpUrl = absoluteUrl.refine((s) => /^https?:\/\//.test(s), "must be an http(s) URL");

export const optionalHttpUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  httpUrl.optional(),
);

export const optionalNonEmptyString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional(),
);

export const dockerSize = z
  .string()
  .trim()
  .regex(/^\d+(?:[kmgKMG])?$/, "must be a Docker size value such as 512m or 1g");

export const optionalDockerSize = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  dockerSize.optional(),
);

export const dockerCpus = z
  .string()
  .trim()
  .regex(/^\d+(?:\.\d+)?$/, "must be a positive CPU count such as 1 or 1.5")
  .refine((value) => Number(value) > 0, "must be greater than zero");

/** A coerced, positive integer env value with a default. */
export const positiveInt = (def: number) => z.coerce.number().int().positive().default(def);

/** A coerced, non-negative integer env value with a default. */
export const nonNegativeInt = (def: number) => z.coerce.number().int().min(0).default(def);

/** A coerced seconds value (fractional allowed) with a lower bound and a default. */
export const secondsWithMin = (min: number, def: number) => z.coerce.number().min(min).default(def);

/** A trimmed, non-empty string env value with a default. */
export const trimmedString = (def: string) => z.string().trim().min(1).default(def);

export const originList = z
  .string()
  .default("")
  .transform((value, ctx) => {
    const origins: string[] = [];
    for (const raw of value.split(",")) {
      const item = raw.trim();
      if (!item) continue;
      try {
        const url = new URL(item);
        if (!/^https?:$/.test(url.protocol)) throw new Error("unsupported scheme");
        origins.push(url.origin);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `invalid trusted origin "${item}"`,
        });
        return z.NEVER;
      }
    }
    return [...new Set(origins)];
  });

function isIpOrCidr(value: string): string | false {
  const slash = value.indexOf("/");
  const address = slash >= 0 ? value.slice(0, slash) : value;
  const family = isIP(address);
  if (family === 0) return false;
  if (slash < 0) return value;

  const prefix = value.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefix)) return false;
  const prefixNum = Number(prefix);
  if (prefixNum > (family === 4 ? 32 : 128)) return false;

  if (family === 6 && /^::ffff:\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address)) {
    const v4 = address.slice(7);
    if (prefixNum < 96) return false;
    const v4Prefix = prefixNum - 96;
    if (v4Prefix > 32) return false;
    return `${v4}/${v4Prefix}`;
  }

  return value;
}

/** A comma-separated, deduplicated list of IP addresses and/or CIDR ranges. */
export const ipOrCidrList = z
  .string()
  .default("")
  .transform((value, ctx) => {
    const entries: string[] = [];
    for (const raw of value.split(",")) {
      const item = raw.trim();
      if (!item) continue;
      const normalized = isIpOrCidr(item);
      if (!normalized) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `invalid IP or CIDR "${item}"`,
        });
        return z.NEVER;
      }
      entries.push(normalized);
    }
    return [...new Set(entries)];
  });

/**
 * A comma-separated plugin allowlist (registries or scanners). An unset/empty
 * value yields `undefined` — meaning "register every built-in plugin" — so the
 * app core never enumerates a concrete registry or scanner; operators narrow the
 * set without a code change.
 */
export const pluginAllowlist = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z
    .string()
    .optional()
    .transform((value) =>
      value === undefined
        ? undefined
        : [
            ...new Set(
              value
                .split(",")
                .map((entry) => entry.trim())
                .filter(Boolean),
            ),
          ],
    ),
);

export const uuidList = z
  .string()
  .default("")
  .transform((value, ctx) => {
    const ids: string[] = [];
    for (const raw of value.split(",")) {
      const id = raw.trim();
      if (!id) continue;
      const parsed = z.uuid().safeParse(id);
      if (!parsed.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `invalid user id "${id}"`,
        });
        return z.NEVER;
      }
      ids.push(id);
    }
    return [...new Set(ids)];
  });

const orgSlug = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, "org must be a slug (2-63 lowercase chars)");

const groupSlug = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9._-]{1,127}$/, "group must be a slug (2-128 chars)");

export const oidcScopes = z
  .string()
  .default("openid profile email groups")
  .transform((value) => [
    ...new Set(
      value
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ])
  .refine((scopes) => scopes.includes("openid"), "AUTH_OIDC_SCOPES must include openid");

const OidcGroupMappingsSchema = z.record(
  z.string().min(1),
  z.array(z.strictObject({ org: orgSlug, group: groupSlug })).min(1),
);

export const oidcGroupMappings = z
  .string()
  .default("{}")
  .transform((value, ctx) => {
    let parsed: unknown;
    try {
      parsed = value.trim() ? JSON.parse(value) : {};
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "AUTH_OIDC_GROUP_MAPPINGS must be valid JSON",
      });
      return z.NEVER;
    }
    const result = OidcGroupMappingsSchema.safeParse(parsed);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({
          ...issue,
          path: ["AUTH_OIDC_GROUP_MAPPINGS", ...issue.path],
        });
      }
      return z.NEVER;
    }
    return result.data;
  });
