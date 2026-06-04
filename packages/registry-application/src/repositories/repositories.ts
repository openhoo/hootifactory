import { count, db, eq, repositories } from "@hootifactory/db";
import type { RegistryModuleDescriptor, ResolvedRepo } from "@hootifactory/registry";
import type { RegistryModuleId, Visibility } from "@hootifactory/types";
import { computeMountPath } from "./paths";

export interface CreateRepositoryInput {
  orgId: string;
  orgSlug: string;
  name: string;
  moduleId: RegistryModuleId;
  module: Pick<RegistryModuleDescriptor, "mountSegment">;
  kind?: "hosted" | "proxy" | "virtual";
  visibility?: Visibility;
  description?: string;
  config?: Record<string, unknown>;
}

export async function createRepository(input: CreateRepositoryInput): Promise<ResolvedRepo> {
  const mountPath = computeMountPath(input.module, input.orgSlug, input.name);
  const [row] = await db
    .insert(repositories)
    .values({
      orgId: input.orgId,
      name: input.name,
      moduleId: input.moduleId,
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

export async function countRepositoriesForOrg(orgId: string): Promise<number> {
  const rows = (await db
    .select({ value: count() })
    .from(repositories)
    .where(eq(repositories.orgId, orgId))) as Array<{ value: number }>;
  return rows[0]?.value ?? 0;
}

export async function listRepositoriesForOrg(
  orgId: string,
  page?: { limit: number; offset: number },
): Promise<ResolvedRepo[]> {
  const query = () =>
    db.select().from(repositories).where(eq(repositories.orgId, orgId)).orderBy(repositories.name);
  return page ? query().limit(page.limit).offset(page.offset) : query();
}
