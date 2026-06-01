import { z } from "zod";
import { type OciErrorCode, RegistryError } from "./errors";

export type { ZodError, ZodType } from "zod";
export { z };

export function zodIssueTree(error: z.ZodError): unknown {
  return z.treeifyError(error);
}

export function parseRegistryInput<T extends z.ZodType>(
  schema: T,
  input: unknown,
  opts: {
    code?: OciErrorCode;
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
