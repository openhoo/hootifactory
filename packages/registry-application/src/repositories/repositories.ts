import { db, eq, repositories } from "@hootifactory/db";
import type { ResolvedRepo } from "@hootifactory/registry";
import type { PackageFormat, Visibility } from "@hootifactory/types";
import { computeMountPath } from "./paths";

export interface CreateRepositoryInput {
  orgId: string;
  orgSlug: string;
  name: string;
  format: PackageFormat;
  kind?: "hosted" | "proxy" | "virtual";
  visibility?: Visibility;
  description?: string;
  config?: Record<string, unknown>;
}

export async function createRepository(input: CreateRepositoryInput): Promise<ResolvedRepo> {
  const mountPath = computeMountPath(input.format, input.orgSlug, input.name);
  const [row] = await db
    .insert(repositories)
    .values({
      orgId: input.orgId,
      name: input.name,
      format: input.format,
      kind: input.kind ?? "hosted",
      visibility: input.visibility ?? "private",
      mountPath,
      storagePrefix: `${input.orgId}/${input.name}`,
      description: input.description,
      config: input.config ?? {},
    })
    .returning();
  if (!row) throw new Error("failed to create repository");
  return row;
}

export async function getRepositoryById(id: string): Promise<ResolvedRepo | null> {
  const [row] = await db.select().from(repositories).where(eq(repositories.id, id)).limit(1);
  return row ?? null;
}

export async function listRepositoriesForOrg(orgId: string): Promise<ResolvedRepo[]> {
  return db.select().from(repositories).where(eq(repositories.orgId, orgId));
}
