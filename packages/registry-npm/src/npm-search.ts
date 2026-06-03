import { parseRegistryInput } from "@hootifactory/registry";
import { NpmSearchQuerySchema, packagePath } from "./npm-validation";

export interface NpmSearchQuery {
  text: string;
  from: number;
  size: number;
}

export interface NpmSearchVersionInput {
  version: string;
  createdAt: Date;
  metadata: unknown;
}

export interface NpmSearchObject {
  package: {
    name: string;
    version: string;
    description: string;
    keywords: unknown[];
    date: string;
    links: { npm: string };
    publisher: { username: string; email: string };
    maintainers: { username: string; email: string }[];
  };
  score: { final: number; detail: { quality: number; popularity: number; maintenance: number } };
  searchScore: number;
}

export function parseNpmSearchQuery(url: string): NpmSearchQuery {
  const searchParams = new URL(url).searchParams;
  return parseRegistryInput(
    NpmSearchQuerySchema,
    {
      text: searchParams.get("text") ?? undefined,
      from: searchParams.get("from") ?? undefined,
      size: searchParams.get("size") ?? undefined,
    },
    { code: "PAGINATION_NUMBER_INVALID", message: "invalid search query" },
  );
}

export function buildNpmSearchObject(input: {
  packageName: string;
  selected: NpmSearchVersionInput;
  baseUrl: string;
  mountPath: string;
}): NpmSearchObject {
  const manifest =
    (input.selected.metadata as { manifest?: Record<string, unknown> } | undefined)?.manifest ?? {};
  return {
    package: {
      name: input.packageName,
      version: input.selected.version,
      description: typeof manifest.description === "string" ? manifest.description : "",
      keywords: Array.isArray(manifest.keywords) ? manifest.keywords : [],
      date: input.selected.createdAt.toISOString(),
      links: { npm: `${input.baseUrl}/${input.mountPath}/${packagePath(input.packageName)}` },
      publisher: { username: "hootifactory", email: "" },
      maintainers: [{ username: "hootifactory", email: "" }],
    },
    score: { final: 1, detail: { quality: 1, popularity: 1, maintenance: 1 } },
    searchScore: 1,
  };
}

export function buildNpmSearchResponse(input: {
  objects: NpmSearchObject[];
  total: number;
  time?: string;
}): { objects: NpmSearchObject[]; total: number; time: string } {
  return {
    objects: input.objects,
    total: input.total,
    time: input.time ?? new Date().toISOString(),
  };
}
