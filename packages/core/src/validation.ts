import { z } from "zod";
import { RegistryError, type RegistryErrorCode } from "./errors";

export type { ZodError, ZodType } from "zod";
export { z };

export const JsonRecordSchema = z.record(z.string(), z.unknown());
export type JsonRecord = z.output<typeof JsonRecordSchema>;

export type JsonParseResult = { success: true; data: unknown } | { success: false; error: unknown };

export function zodIssueTree(error: z.ZodError): unknown {
  return z.treeifyError(error);
}

export function safeJsonParse(text: string): JsonParseResult {
  try {
    return { success: true, data: JSON.parse(text) };
  } catch (error) {
    return { success: false, error };
  }
}

export function parseJsonWithSchema<T extends z.ZodType>(
  schema: T,
  text: string,
): z.output<T> | null {
  const decoded = safeJsonParse(text);
  if (!decoded.success) return null;
  const parsed = schema.safeParse(decoded.data);
  return parsed.success ? parsed.data : null;
}

export function asJsonRecord(value: unknown): JsonRecord | null {
  const parsed = JsonRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function jsonRecordOrEmpty(value: unknown): JsonRecord {
  return asJsonRecord(value) ?? {};
}

export function parseRegistryInput<T extends z.ZodType>(
  schema: T,
  input: unknown,
  opts: {
    code?: RegistryErrorCode;
    message?: string;
    status?: number;
  } = {},
): z.output<T> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new RegistryError(
    opts.status ?? 400,
    opts.code ?? "UNSUPPORTED",
    opts.message ?? "invalid request",
    zodIssueTree(parsed.error),
  );
}
