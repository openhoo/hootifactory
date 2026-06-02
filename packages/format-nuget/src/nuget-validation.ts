import { z } from "@hootifactory/core";
import type { NuspecDependencyGroup } from "./nuspec";

export interface NugetVersionMeta {
  nupkgDigest: string;
  file: string;
  displayId?: string;
  listed?: boolean;
  semVer2?: boolean;
  dependencyGroups?: NuspecDependencyGroup[];
}

const PACKAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const PACKAGE_FILE_RE = /^[^/\\]+\.(?:nupkg|nuspec)$/i;

export const NugetIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(PACKAGE_ID_RE, "invalid NuGet package id");

export const NugetVersionInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) => normalizeNugetVersion(value) != null, "invalid NuGet package version");

export const NugetFileSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(PACKAGE_FILE_RE, "invalid NuGet package filename");

export const NugetPublishQuerySchema = z.strictObject({
  id: NugetIdSchema.optional(),
  version: NugetVersionInputSchema.optional(),
});

/** NuGet version normalization: drop a zero 4th segment + build metadata, lowercase prerelease. */
export function normalizeNugetVersion(version: string): string | null {
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
  if (parts.length > 4 || parts.some((part) => !/^\d+$/.test(part))) return null;

  const numbers = parts.map((part) => String(Number.parseInt(part, 10)));
  while (numbers.length < 3) numbers.push("0");
  if (numbers.length === 4 && numbers[3] === "0") numbers.pop();

  const prerelease = prereleaseRaw ? `-${prereleaseRaw.toLowerCase()}` : "";
  return numbers.join(".") + prerelease;
}

export function isPrereleaseNugetVersion(version: string): boolean {
  return version.includes("-");
}

export function isSemVer2NugetVersion(version: string): boolean {
  const normalized = version.trim();
  if (normalized.includes("+")) return true;
  const dash = normalized.indexOf("-");
  return dash >= 0 && normalized.slice(dash + 1).includes(".");
}

/** Compare two normalized NuGet versions (numeric core; a release outranks its prerelease). */
export function compareNugetVersions(a: string, b: string): number {
  const pa = splitNugetVersion(a);
  const pb = splitNugetVersion(b);
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

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function validPrerelease(prerelease: string): boolean {
  return prerelease.split(".").every((part) => /^[0-9A-Za-z-]+$/.test(part));
}

function splitNugetVersion(version: string): { core: number[]; prerelease: string | null } {
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
