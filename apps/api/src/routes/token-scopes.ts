import {
  type Action,
  authorize,
  type Decision,
  type Principal,
  type RegistryAccess,
} from "@hootifactory/auth";
import { z } from "@hootifactory/core";
import type { ResolvedRepo } from "@hootifactory/registry";
import { resolveRepository } from "@hootifactory/registry-application";

export const TokenQuerySchema = z.strictObject({
  service: z.string().min(1).max(512).optional(),
  scopes: z.array(z.string().min(1).max(4096)).max(100),
});

const DockerScopeSchema = z
  .string()
  .min(1)
  .max(4096)
  .transform((scope, ctx) => {
    const firstColon = scope.indexOf(":");
    const lastColon = scope.lastIndexOf(":");
    if (firstColon < 0 || lastColon <= firstColon) {
      ctx.addIssue({ code: "custom", message: "scope must be type:name:actions" });
      return z.NEVER;
    }
    const type = scope.slice(0, firstColon);
    const name = scope.slice(firstColon + 1, lastColon);
    const requested = scope
      .slice(lastColon + 1)
      .split(",")
      .filter(Boolean);
    if (type !== "repository") {
      ctx.addIssue({ code: "custom", message: "scope type must be repository" });
      return z.NEVER;
    }
    if (!name || name.length > 512 || name.includes("..") || name.startsWith("/")) {
      ctx.addIssue({ code: "custom", message: "scope repository name is invalid" });
      return z.NEVER;
    }
    if (requested.length === 0 || requested.length > 4) {
      ctx.addIssue({ code: "custom", message: "scope actions are invalid" });
      return z.NEVER;
    }
    for (const action of requested) {
      if (!["pull", "push", "delete", "*"].includes(action)) {
        ctx.addIssue({ code: "custom", message: `unsupported scope action '${action}'` });
        return z.NEVER;
      }
    }
    return { type, name, requested };
  });

export type DockerScope = z.infer<typeof DockerScopeSchema>;

export interface DockerScopeGrant {
  access: RegistryAccess;
  repositoryResolved: boolean;
}

export interface GrantDockerScopeDeps {
  authorizeAction?: (
    principal: Principal,
    action: Action,
    resource: {
      type: "repository";
      orgId: string;
      repositoryId: string;
      repositoryName: string;
      visibility: ResolvedRepo["visibility"];
    },
  ) => Promise<Decision>;
  resolveRepositoryPath?: typeof resolveRepository;
}

export function parseDockerScopes(rawScopes: string[]) {
  return z
    .array(DockerScopeSchema)
    .safeParse(rawScopes.flatMap((s) => s.split(" ")).filter(Boolean));
}

export function dockerToRbac(action: string): "read" | "write" | "delete" | null {
  if (action === "pull") return "read";
  if (action === "push") return "write";
  if (action === "delete") return "delete";
  return null;
}

export function requestedDockerActions(scope: DockerScope): string[] {
  return scope.requested.flatMap((action) =>
    action === "*" ? ["pull", "push", "delete"] : [action],
  );
}

export async function grantDockerScope(
  principal: Principal,
  scope: DockerScope,
  deps: GrantDockerScopeDeps = {},
): Promise<DockerScopeGrant> {
  const access: RegistryAccess = { type: "repository", name: scope.name, actions: [] };
  const resolveRepositoryPath = deps.resolveRepositoryPath ?? resolveRepository;
  const authorizeAction = deps.authorizeAction ?? authorize;
  const resolution = await resolveRepositoryPath(`/v2/${scope.name}`);
  if (!resolution) return { access, repositoryResolved: false };

  const { repo } = resolution;
  for (const dockerAction of requestedDockerActions(scope)) {
    const rbac = dockerToRbac(dockerAction);
    if (!rbac) continue;
    const decision = await authorizeAction(principal, rbac, {
      type: "repository",
      orgId: repo.orgId,
      repositoryId: repo.id,
      repositoryName: scope.name,
      visibility: repo.visibility,
    });
    if (decision.allowed && !access.actions.includes(dockerAction)) {
      access.actions.push(dockerAction);
    }
  }
  return { access, repositoryResolved: true };
}
