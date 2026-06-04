import { z } from "@hootifactory/core";

const ExecuteRowsSchema = z.looseObject({
  rows: z.array(z.unknown()),
});

const ClaimedScanIntentRowSchema = z.looseObject({
  id: z.string().min(1),
  artifactId: z.unknown().optional(),
  artifact_id: z.unknown().optional(),
  attempts: z.unknown(),
});

export interface ClaimedScanIntent {
  id: string;
  artifactId: string;
  attempts: number;
}

function rowsFromExecute(result: unknown): unknown[] {
  const rows = z.array(z.unknown()).safeParse(result);
  if (rows.success) return rows.data;
  const resultRows = ExecuteRowsSchema.safeParse(result);
  return resultRows.success ? resultRows.data.rows : [];
}

function claimedRow(row: unknown): ClaimedScanIntent | null {
  const parsed = ClaimedScanIntentRowSchema.safeParse(row);
  if (!parsed.success) return null;
  const artifactId =
    typeof parsed.data.artifactId === "string"
      ? parsed.data.artifactId
      : typeof parsed.data.artifact_id === "string"
        ? parsed.data.artifact_id
        : null;
  const attempts = Number(parsed.data.attempts);
  if (!artifactId || !Number.isFinite(attempts)) return null;
  return { id: parsed.data.id, artifactId, attempts };
}

export function claimedScanIntentsFromExecute(result: unknown): ClaimedScanIntent[] {
  return rowsFromExecute(result).flatMap((row) => {
    const claimed = claimedRow(row);
    return claimed ? [claimed] : [];
  });
}
