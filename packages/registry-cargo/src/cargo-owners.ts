import { Errors, parseRegistryInput } from "@hootifactory/registry";
import { CargoOwnersBodySchema } from "./cargo-validation";

export interface CargoOwnerRow {
  id: string;
  login: string;
  name: string | null;
}

export interface CargoOwner {
  id: number;
  login: string;
  name: string | null;
}

export interface CargoOwnersBody {
  users: string[];
}

export function cargoOwnerId(userId: string): number {
  return Number.parseInt(userId.replaceAll("-", "").slice(0, 8), 16) >>> 0;
}

export function buildCargoOwnersBody(rows: CargoOwnerRow[]): { users: CargoOwner[] } {
  const seen = new Set<string>();
  const owners: CargoOwner[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    owners.push({ id: cargoOwnerId(row.id), login: row.login, name: row.name });
  }
  return { users: owners };
}

export async function parseCargoOwnersRequest(req: Request): Promise<CargoOwnersBody> {
  const rawBody = await req.json().catch(() => {
    throw Errors.manifestInvalid({ reason: "invalid owners request json" });
  });
  return parseRegistryInput(CargoOwnersBodySchema, rawBody, {
    code: "MANIFEST_INVALID",
    message: "invalid owners request",
  });
}

export function buildCargoOwnersUpdateBody(
  userCount: number,
  action: "add" | "remove",
): { ok: true; msg: string } {
  const verb = action === "add" ? "added" : "removed";
  return {
    ok: true,
    msg: `${userCount} requested owner(s) ${verb}; crate owners are managed through Hootifactory repository permissions`,
  };
}
