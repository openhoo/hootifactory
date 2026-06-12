import { type Env, loadEnv } from "./schema";

export type { Env };

/** The validated, frozen runtime environment. */
export const env: Env = loadEnv();

export const isProduction = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";

/** Re-parse a custom source (used in tests). */
export { loadEnv };
