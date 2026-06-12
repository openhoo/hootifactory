import { DIGEST_RE, z } from "@hootifactory/core";

/**
 * Shared digest validation schemas for registry plugins.
 *
 * Before this module each format package re-declared its own
 * `z.string().regex(/^sha256:[a-f0-9]{64}$/)` (and a bare-hex variant), so a
 * subtle drift in the character class or anchoring could pass one plugin's
 * validation and fail another's. Both schemas below are derived from the single
 * canonical {@link DIGEST_RE} in `@hootifactory/core`, so every plugin validates
 * digests identically.
 */

/** Lowercase hex sha256 with no prefix: exactly 64 hex characters. */
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** Zod schema for a bare lowercase sha256 hex string (64 hex chars, no prefix). */
export const Sha256HexSchema = z.string().regex(SHA256_HEX_RE);

/** Zod schema for a canonical `sha256:<64-hex>` digest string. */
export const Sha256DigestSchema = z.string().regex(DIGEST_RE);
