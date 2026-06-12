import { Sha256DigestSchema, z } from "@hootifactory/registry";

/**
 * Chocolatey speaks the NuGet OData v2 (Atom/XML) feed protocol. Package ids,
 * versions, and the stored metadata shape mirror NuGet's, but everything here is
 * owned by this package (no cross-plugin imports).
 */

const PACKAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export const ChocolateyIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(PACKAGE_ID_RE, "invalid Chocolatey package id");

export const ChocolateyVersionInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine(
    (value) => normalizeChocolateyVersion(value) != null,
    "invalid Chocolatey package version",
  );

export interface ChocolateyDependency {
  id: string;
  range: string;
}

export interface ChocolateyVersionMeta {
  nupkgDigest: string;
  packageHash: string;
  packageHashAlgorithm: "SHA512" | "SHA256";
  size: number;
  id: string;
  version: string;
  title?: string;
  authors?: string;
  description?: string;
  tags?: string;
  dependencies?: ChocolateyDependency[];
  listed?: boolean;
}

// The OData v2 feed serializes a dependency set as `id:range:tfm` entries
// joined by `|` (see `encodeDependencies`). `:` and `|` are therefore reserved
// structural delimiters with no escape mechanism in that grammar, and a valid
// NuGet version range never contains them. Reject ranges carrying either so a
// crafted range cannot inject forged/malformed `<d:Dependencies>` entries.
export const ChocolateyDependencySchema = z.strictObject({
  id: ChocolateyIdSchema,
  range: z
    .string()
    .max(512)
    .refine((value) => !/[:|]/.test(value), "dependency range must not contain ':' or '|'"),
});

export const ChocolateyVersionMetaSchema = z.strictObject({
  nupkgDigest: Sha256DigestSchema,
  packageHash: z.string().min(1).max(256),
  packageHashAlgorithm: z.enum(["SHA512", "SHA256"]),
  size: z.number().int().nonnegative(),
  id: ChocolateyIdSchema,
  version: z.string().min(1).max(256),
  title: z.string().max(1024).optional(),
  authors: z.string().max(4096).optional(),
  description: z.string().max(16_384).optional(),
  tags: z.string().max(4096).optional(),
  dependencies: z.array(ChocolateyDependencySchema).max(512).optional(),
  listed: z.boolean().optional(),
});

export function parseChocolateyVersionMeta(value: unknown): ChocolateyVersionMeta | null {
  const parsed = ChocolateyVersionMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * NuGet/Chocolatey version normalization: numeric core (3-4 segments), drop a
 * trailing zero 4th segment and build metadata, lowercase the prerelease tag.
 */
export function normalizeChocolateyVersion(version: string): string | null {
  let normalized = version.trim();
  if (!normalized) return null;
  const plus = normalized.indexOf("+");
  if (plus >= 0) normalized = normalized.slice(0, plus);

  const dash = normalized.indexOf("-");
  const core = dash >= 0 ? normalized.slice(0, dash) : normalized;
  const prereleaseRaw = dash >= 0 ? normalized.slice(dash + 1) : "";
  if (dash >= 0 && !prereleaseRaw) return null;
  if (prereleaseRaw && !validPrerelease(prereleaseRaw)) return null;

  const parts = core.split(".");
  if (parts.length < 2 || parts.length > 4 || parts.some((part) => !/^\d+$/.test(part)))
    return null;

  const numbers = parts.map((part) => String(Number.parseInt(part, 10)));
  while (numbers.length < 3) numbers.push("0");
  if (numbers.length === 4 && numbers[3] === "0") numbers.pop();

  const prerelease = prereleaseRaw ? `-${prereleaseRaw.toLowerCase()}` : "";
  return numbers.join(".") + prerelease;
}

export function isPrereleaseChocolateyVersion(version: string): boolean {
  return version.includes("-");
}

/**
 * Render a canonical OData v2 `Edm.DateTime` (timezone-less, no fractional
 * seconds, no trailing `Z`) — e.g. `2026-01-02T00:00:00`. NuGet's `<d:Published>`
 * uses this form; `Date.toISOString()` (DateTimeOffset semantics) does not.
 */
export function toEdmDateTime(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "");
}

function validPrerelease(prerelease: string): boolean {
  return prerelease.split(".").every((part) => /^[0-9A-Za-z-]+$/.test(part));
}

/** Compare two normalized versions; a release outranks its prerelease. */
export function compareChocolateyVersions(a: string, b: string): number {
  const pa = splitVersion(a);
  const pb = splitVersion(b);
  const maxCore = Math.max(pa.core.length, pb.core.length);
  for (let i = 0; i < maxCore; i++) {
    const diff = (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (!pa.prerelease && pb.prerelease) return 1;
  if (pa.prerelease && !pb.prerelease) return -1;
  if (pa.prerelease && pb.prerelease) return comparePrerelease(pa.prerelease, pb.prerelease);
  return 0;
}

function splitVersion(version: string): { core: number[]; prerelease: string | null } {
  const dash = version.indexOf("-");
  return {
    core: (dash >= 0 ? version.slice(0, dash) : version).split(".").map(Number),
    prerelease: dash >= 0 ? version.slice(dash + 1) : null,
  };
}

function comparePrerelease(a: string, b: string): number {
  const aa = a.split(".");
  const bb = b.split(".");
  const max = Math.max(aa.length, bb.length);
  for (let i = 0; i < max; i++) {
    const x = aa[i];
    const y = bb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumber = /^(0|[1-9]\d*)$/.test(x);
    const yNumber = /^(0|[1-9]\d*)$/.test(y);
    if (xNumber && yNumber) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff;
    } else if (xNumber !== yNumber) {
      return xNumber ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** Escape text for inclusion in XML element/attribute content. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Parse the `Id='X',Version='Y'` OData key segment used by the
 * `Packages(Id='X',Version='Y')` route. Returns null when the segment cannot be
 * decomposed into both keys.
 */
export function parseODataKey(segment: string): { id: string; version: string } | null {
  const open = segment.indexOf("(");
  const close = segment.endsWith(")") ? segment.length - 1 : segment.length;
  if (open >= 0) segment = segment.slice(open + 1, close);
  const values: Record<string, string> = {};
  let i = 0;
  while (i < segment.length) {
    while (segment[i] === " " || segment[i] === ",") i += 1;
    const keyStart = i;
    while (i < segment.length && /[A-Za-z]/.test(segment[i] ?? "")) i += 1;
    const key = segment.slice(keyStart, i).toLowerCase();
    while (segment[i] === " ") i += 1;
    if (!key || segment[i] !== "=") return null;
    i += 1;
    while (segment[i] === " ") i += 1;
    if (segment[i] !== "'") return null;
    i += 1;
    let value = "";
    while (i < segment.length) {
      const char = segment[i] ?? "";
      if (char === "'") {
        if (segment[i + 1] === "'") {
          value += "'";
          i += 2;
          continue;
        }
        i += 1;
        break;
      }
      value += char;
      i += 1;
    }
    values[key] = value;
    while (segment[i] === " ") i += 1;
    if (i < segment.length && segment[i] !== ",") return null;
  }
  const id = values.id;
  const version = values.version;
  if (id === undefined || version === undefined) return null;
  return { id, version };
}

/** Strip surrounding single quotes from an OData query-string literal. */
export function unquoteODataLiteral(value: string | null): string {
  if (value === null) return "";
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}
