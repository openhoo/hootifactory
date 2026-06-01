import type { Attributes } from "@opentelemetry/api";
import { messageFor } from "./otel-helpers";

const MAX_META_ATTRIBUTES = 32;
const MAX_META_ATTRIBUTE_LENGTH = 4096;
const MAX_JSON_DEPTH = 6;

export function attributesForMeta(meta: unknown): Attributes {
  if (meta === undefined || meta === null) return {};
  const error = errorForMeta(meta);
  if (meta instanceof Error) {
    return exceptionAttributes(meta);
  }
  if (typeof meta !== "object" || Array.isArray(meta)) {
    return { "meta.value": String(meta) };
  }

  const attrs: Attributes = {};
  if (error) Object.assign(attrs, exceptionAttributes(error));

  for (const [key, value] of objectEntries(meta).slice(0, MAX_META_ATTRIBUTES)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      attrs[`meta.${key}`] = value;
    } else if (value != null) {
      attrs[`meta.${key}`] = truncate(
        safeJsonStringify(sanitizeForJson(value)),
        MAX_META_ATTRIBUTE_LENGTH,
      );
    }
  }
  return attrs;
}

export function errorForMeta(meta: unknown): Error | undefined {
  if (meta instanceof Error) return meta;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const nested = readProperty(meta, "error");
    if (nested instanceof Error) return nested;
  }
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

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    try {
      out[key] = sanitizeForJson((value as Record<string, unknown>)[key], seen, depth + 1);
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
    return (value as Record<string, unknown>)[key];
  } catch (err) {
    return `[Thrown: ${messageFor(err)}]`;
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}
