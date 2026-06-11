import { z } from "@hootifactory/core";
import { and, eq, scanOutbox } from "@hootifactory/db";
import type { TelemetryContextCarrier } from "@hootifactory/observability";
import { SCAN_OUTBOX_STATUS } from "@hootifactory/scan-core";

const ExecuteRowsSchema = z.looseObject({
  rows: z.array(z.unknown()),
});

const ClaimedScanIntentRowSchema = z.looseObject({
  id: z.string().min(1),
  artifactId: z.unknown().optional(),
  artifact_id: z.unknown().optional(),
  attempts: z.unknown(),
  telemetry: z.unknown().optional(),
});

/**
 * The telemetry context carrier stamped on the row at publish time (issue #341).
 * Parsed defensively: telemetry is best-effort linkage, so a malformed value must
 * degrade to "no carrier" rather than fail the claim and block the scan itself.
 */
const TelemetryCarrierSchema = z.looseObject({
  trace: z.record(z.string(), z.string()).optional(),
  requestId: z.string().optional(),
  correlationId: z.string().optional(),
});

function telemetryCarrier(value: unknown): TelemetryContextCarrier | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = TelemetryCarrierSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { trace, requestId, correlationId } = parsed.data;
  if (!trace && !requestId && !correlationId) return undefined;
  return { trace, requestId, correlationId };
}

export interface ClaimedScanIntent {
  id: string;
  artifactId: string;
  /**
   * The attempt number stamped when this attempt was claimed (claimScanIntents
   * increments it on every claim, so it is strictly monotonic per row). It doubles
   * as the optimistic-concurrency claim token: a terminal write finalizes a row only
   * while it is still 'processing' at this exact attempt. If a re-publish reset the
   * row to 'pending' and a worker re-claimed it, attempts has advanced, so the prior
   * worker's terminal UPDATE matches nothing and cannot clobber the new attempt.
   * Unlike locked_at, attempts is an integer and so is immune to the microsecond vs
   * millisecond precision loss that breaks timestamptz equality round-trips.
   */
  attempts: number;
  /**
   * Publish-time telemetry context restored around the per-artifact scan span so
   * publish->scan traces link. Absent when the row was enqueued outside a traced
   * request or the stored carrier is malformed.
   */
  telemetry?: TelemetryContextCarrier;
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
  return {
    id: parsed.data.id,
    artifactId,
    attempts,
    telemetry: telemetryCarrier(parsed.data.telemetry),
  };
}

export function claimedScanIntentsFromExecute(result: unknown): ClaimedScanIntent[] {
  return rowsFromExecute(result).flatMap((row) => {
    const claimed = claimedRow(row);
    return claimed ? [claimed] : [];
  });
}

/**
 * Build the optimistic-concurrency WHERE clause for a terminal scan-outbox write.
 * A worker may finalize a row only if it is still the exact attempt it claimed:
 * same id, still 'processing', and the same attempts value it was stamped with at
 * claim time. If a re-publish reset the row to 'pending' and another worker
 * re-claimed it (advancing attempts), or a reclaim moved it out of 'processing',
 * this filter matches nothing and the UPDATE is a no-op, so a stale worker cannot
 * clobber a newer attempt or a re-requested rescan.
 */
export function claimedAttemptFilter(intent: ClaimedScanIntent) {
  return and(
    eq(scanOutbox.id, intent.id),
    eq(scanOutbox.status, SCAN_OUTBOX_STATUS.processing),
    eq(scanOutbox.attempts, intent.attempts),
  );
}
