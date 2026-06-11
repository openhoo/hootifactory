import type { Attributes } from "@opentelemetry/api";
import { z } from "zod";
import { messageFor } from "./otel-helpers";

const MAX_META_ATTRIBUTES = 32;
const MAX_META_ATTRIBUTE_LENGTH = 4096;
const MAX_JSON_DEPTH = 6;
const REDACTED = "[redacted]";

/**
 * Terms that mark a meta key as sensitive when they appear as a whole word
 * anywhere in the key (words are split on case changes and non-alphanumeric
 * separators, with a single trailing "s" tolerated): "authorization",
 * "cookie", "password", "secret", "credential".
 */
const SENSITIVE_LOG_KEY_TERMS = new Set([
  "authorization",
  "cookie",
  "password",
  "secret",
  "credential",
]);

const KEY_WORDS_PATTERN = /[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+/g;

function keyWords(key: string): string[] {
  return (key.match(KEY_WORDS_PATTERN) ?? []).map((word) => word.toLowerCase());
}

/**
 * Whether a meta key should have its value masked in log output.
 *
 * Boundary rules (whole-word, not substring, so "secretive" or "tokenizer"
 * never match):
 * - The terms in {@link SENSITIVE_LOG_KEY_TERMS} match as a word anywhere in
 *   the key, singular or plural: "password", "clientSecret", "secret_key",
 *   "Set-Cookie", "credentials".
 * - "token" only matches as the FINAL word and only in the singular, so
 *   "accessToken", "refresh_token", and "x-auth-token" are masked while
 *   token-accounting metrics such as "tokenCount", "totalTokens", and
 *   "inputTokens" are kept.
 */
export function isSensitiveLogKey(key: string): boolean {
  const words = keyWords(key);
  for (const [index, word] of words.entries()) {
    const singular = word.endsWith("s") ? word.slice(0, -1) : word;
    if (SENSITIVE_LOG_KEY_TERMS.has(word) || SENSITIVE_LOG_KEY_TERMS.has(singular)) return true;
    if (word === "token" && index === words.length - 1) return true;
  }
  return false;
}
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
    if (isSensitiveLogKey(key)) {
      // Keep the key so the log line shows the field existed, but mask the
      // entire value (strings, numbers, and nested structures alike).
      out[key] = REDACTED;
      continue;
    }
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
