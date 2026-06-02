import { z } from "@hootifactory/core";

export interface GoVersionMeta {
  mod: string;
  zipDigest: string;
  zipSize: number;
  time: string;
}

/** Decode Go module "!"-escaping (an uppercase letter is encoded as `!` + lowercase). */
export function decodeBang(value: string): string | null {
  let decoded = "";
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (!char) continue;
    if (char >= "A" && char <= "Z") return null;
    if (char !== "!") {
      decoded += char;
      continue;
    }
    const escaped = value[i + 1];
    if (!escaped || escaped < "a" || escaped > "z") return null;
    decoded += escaped.toUpperCase();
    i++;
  }
  return decoded;
}

/** Canonical Go semver: vMAJOR.MINOR.PATCH with optional -prerelease / +build. */
const GO_VERSION_RE = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export const GoModuleSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.split("/").some((part) => !part || part === "." || part === ".."),
    "invalid Go module path",
  );

export const GoVersionSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(GO_VERSION_RE, "version must be a canonical Go semver")
  .refine((value) => parseSemver(value) != null, "version must be a canonical Go semver");

export const GoVersionFileSchema = z
  .string()
  .min(1)
  .max(300)
  .regex(/^.+\.(info|mod|zip)$/, "invalid Go version file");

export const GoUploadFieldsSchema = z.strictObject({
  mod: z.string().min(1).max(1_000_000),
  zip: z.custom<File>((value) => value instanceof File, { message: "missing zip" }),
});

const GO_PSEUDO_VERSION_RE =
  /^v\d+\.(?:0\.0-|\d+\.\d+-(?:[^+]*\.)?0\.)\d{14}-[A-Za-z0-9]+(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function isPseudoVersion(version: string): boolean {
  return GO_PSEUDO_VERSION_RE.test(version) && parseSemver(version) != null;
}

/** Split a vX.Y.Z[-pre] version into numeric parts + prerelease for comparison. */
export function parseSemver(version: string): { nums: number[]; pre: string | null } | null {
  const match = version.match(/^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return null;
  if (match[4] && !validPrerelease(match[4])) return null;
  return {
    nums: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ?? null,
  };
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return a < b ? -1 : a > b ? 1 : 0;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
  }
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  if (pa.pre && pb.pre) return comparePrerelease(pa.pre, pb.pre);
  return 0;
}

/** Go @latest: highest release version; only fall back to a prerelease if no release exists. */
export function pickLatest(versions: string[]): string | undefined {
  if (versions.length === 0) return undefined;
  const sorted = [...versions].sort(compareSemver);
  const releases = sorted.filter((version) => !parseSemver(version)?.pre);
  return (releases.length ? releases : sorted).at(-1);
}

function validPrerelease(prerelease: string): boolean {
  return prerelease.split(".").every((part) => {
    if (!/^[0-9A-Za-z-]+$/.test(part)) return false;
    return !/^\d+$/.test(part) || /^(0|[1-9]\d*)$/.test(part);
  });
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
    const xNumber = /^\d+$/.test(x);
    const yNumber = /^\d+$/.test(y);
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
