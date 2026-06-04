import type { Attributes } from "@opentelemetry/api";
import { z } from "zod";
import { messageFor } from "./otel-helpers";

const MAX_META_ATTRIBUTES = 32;
const MAX_META_ATTRIBUTE_LENGTH = 4096;
const MAX_JSON_DEPTH = 6;
const ObjectLikeSchema = z.custom<object>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
);

function objectLike(value: unknown): object | null {
  const parsed = ObjectLikeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function attributesForMeta(meta: unknown): Attributes {
  if (meta === undefined || meta === null) return {};
  const error = errorForMeta(meta);
  if (meta instanceof Error) {
    return exceptionAttributes(meta);
  }
  return attributesForSanitizedMeta(sanitizeForJson(meta), error);
}

export function attributesForSanitizedMeta(meta: unknown, error?: Error): Attributes {
  if (meta === undefined || meta === null) return error ? exceptionAttributes(error) : {};
  const objectMeta = objectLike(meta);
  if (!objectMeta) {
    return {
      ...(error ? exceptionAttributes(error) : {}),
      "meta.value": String(meta),
    };
  }

  const attrs: Attributes = {};
  if (error) Object.assign(attrs, exceptionAttributes(error));

  for (const [key, value] of objectEntries(objectMeta).slice(0, MAX_META_ATTRIBUTES)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      attrs[`meta.${key}`] = value;
    } else if (value != null) {
      attrs[`meta.${key}`] = truncate(safeJsonStringify(value), MAX_META_ATTRIBUTE_LENGTH);
    }
  }
  return attrs;
}

export function errorForMeta(meta: unknown): Error | undefined {
  if (meta instanceof Error) return meta;
  const objectMeta = objectLike(meta);
  if (!objectMeta) return undefined;
  const nested = readProperty(objectMeta, "error");
  if (nested instanceof Error) return nested;
  return undefined;
}

export function sanitizeForJson(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (typeof value === "bigint") return value.toString();
  if (value == null || typeof value !== "object") return value;
  if (value instanceof Uint8Array) {
    return { type: "Uint8Array", byteLength: value.byteLength };
  }
  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_JSON_DEPTH) return "[Truncated]";

  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForJson(item, seen, depth + 1));
  }

  const objectValue = objectLike(value);
  if (!objectValue) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(objectValue)) {
    try {
      out[key] = sanitizeForJson(readProperty(objectValue, key), seen, depth + 1);
    } catch (err) {
      out[key] = `[Thrown: ${messageFor(err)}]`;
    }
  }
  return out;
}

export function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (err) {
    return JSON.stringify({
      t: new Date().toISOString(),
      level: "error",
      msg: "failed to serialize log line",
      meta: messageFor(err),
    });
  }
}

function exceptionAttributes(error: Error): Attributes {
  return {
    "exception.type": error.name,
    "exception.message": error.message,
    ...(error.stack ? { "exception.stacktrace": error.stack } : {}),
  };
}

function objectEntries(value: object): [string, unknown][] {
  const entries: [string, unknown][] = [];
  for (const key of Object.keys(value)) {
    entries.push([key, readProperty(value, key)]);
  }
  return entries;
}

function readProperty(value: object, key: string): unknown {
  try {
    return Reflect.get(value, key);
  } catch (err) {
    return `[Thrown: ${messageFor(err)}]`;
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}
