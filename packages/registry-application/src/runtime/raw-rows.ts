import { z } from "@hootifactory/core";

const ExecuteRowsSchema = z.looseObject({
  rows: z.array(z.unknown()),
});

const RawRecordSchema = z.record(z.string(), z.unknown());

function rawRecord(row: unknown): Record<string, unknown> | null {
  const parsed = RawRecordSchema.safeParse(row);
  return parsed.success ? parsed.data : null;
}

export function rowsFromExecute(result: unknown): unknown[] {
  const arrayRows = z.array(z.unknown()).safeParse(result);
  if (arrayRows.success) return arrayRows.data;
  const objectRows = ExecuteRowsSchema.safeParse(result);
  return objectRows.success ? objectRows.data.rows : [];
}

export function fieldValue(row: unknown, field: string): unknown {
  return rawRecord(row)?.[field] ?? null;
}

export function stringField(row: unknown, field: string): string | null {
  const value = fieldValue(row, field);
  return typeof value === "string" ? value : null;
}

export function dateField(row: unknown, field: string): Date | null {
  const value = fieldValue(row, field);
  if (value instanceof Date) return value;
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function numberField(row: unknown, field: string): number | null {
  const value = fieldValue(row, field);
  if (typeof value === "number") return value;
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function booleanField(row: unknown, field: string): boolean {
  return Boolean(fieldValue(row, field));
}
