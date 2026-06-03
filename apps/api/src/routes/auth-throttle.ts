import { authenticateUserPassword, type Principal } from "@hootifactory/auth";
import { env } from "@hootifactory/config";

export interface AuthThrottleBucket {
  count: number;
  resetAt: number;
}

const loginFailures = new Map<string, AuthThrottleBucket>();
const passwordResetRequests = new Map<string, AuthThrottleBucket>();

export function loginThrottleKey(username: string, ip: string): string {
  return throttleKey(username, ip);
}

export function passwordResetThrottleKey(email: string, ip: string): string {
  return throttleKey(email, ip);
}

export function currentThrottleBucket(
  buckets: Map<string, AuthThrottleBucket>,
  key: string,
  windowSeconds: number,
  now = Date.now(),
  maxBuckets = env.AUTH_THROTTLE_MAX_BUCKETS,
): AuthThrottleBucket {
  const existing = buckets.get(key);
  if (existing && existing.resetAt > now) {
    buckets.delete(key);
    buckets.set(key, existing);
    return existing;
  }
  pruneThrottleBuckets(buckets, now, maxBuckets);
  while (buckets.size >= maxBuckets) {
    const oldest = buckets.keys().next().value;
    if (oldest === undefined) break;
    buckets.delete(oldest);
  }
  const fresh = {
    count: 0,
    resetAt: now + windowSeconds * 1000,
  };
  buckets.set(key, fresh);
  return fresh;
}

export function pruneThrottleBuckets(
  buckets: Map<string, AuthThrottleBucket>,
  now = Date.now(),
  maxBuckets = env.AUTH_THROTTLE_MAX_BUCKETS,
): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  while (buckets.size > maxBuckets) {
    const oldest = buckets.keys().next().value;
    if (oldest === undefined) break;
    buckets.delete(oldest);
  }
}

export function retryAfterSeconds(bucket: AuthThrottleBucket, now = Date.now()): number {
  return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
}

export function loginIsThrottled(
  key: string,
): { throttled: false } | { throttled: true; retryAfter: number } {
  const bucket = currentLoginBucket(key);
  if (bucket.count < env.AUTH_LOGIN_MAX_ATTEMPTS) return { throttled: false };
  return { throttled: true, retryAfter: retryAfterSeconds(bucket) };
}

export function recordLoginFailure(key: string): AuthThrottleBucket {
  const bucket = currentLoginBucket(key);
  bucket.count += 1;
  return bucket;
}

export function passwordResetIsThrottled(
  key: string,
): { throttled: false } | { throttled: true; retryAfter: number } {
  const bucket = currentPasswordResetBucket(key);
  if (bucket.count < env.AUTH_PASSWORD_RESET_MAX_ATTEMPTS) return { throttled: false };
  return { throttled: true, retryAfter: retryAfterSeconds(bucket) };
}

export function recordPasswordResetRequest(key: string): AuthThrottleBucket {
  const bucket = currentPasswordResetBucket(key);
  bucket.count += 1;
  return bucket;
}

export function clearLoginFailures(key: string): void {
  loginFailures.delete(key);
}

type UserPrincipal = Extract<Principal, { kind: "user" }>;

export type ThrottledPasswordAuthResult =
  | { kind: "authenticated"; principal: UserPrincipal }
  | { kind: "invalid"; failure: AuthThrottleBucket }
  | { kind: "throttled"; retryAfter: number };

export async function authenticateUserPasswordWithThrottle(
  username: string,
  password: string,
  ip: string,
  verify: (
    username: string,
    password: string,
  ) => Promise<Principal | null> = authenticateUserPassword,
): Promise<ThrottledPasswordAuthResult> {
  const key = loginThrottleKey(username, ip);
  const throttle = loginIsThrottled(key);
  if (throttle.throttled) return { kind: "throttled", retryAfter: throttle.retryAfter };

  const principal = await verify(username, password);
  if (principal?.kind === "user") {
    clearLoginFailures(key);
    return { kind: "authenticated", principal };
  }

  return { kind: "invalid", failure: recordLoginFailure(key) };
}

function throttleKey(identity: string, ip: string): string {
  return `${identity.trim().toLowerCase()}\0${ip}`;
}

function currentLoginBucket(key: string, now = Date.now()): AuthThrottleBucket {
  return currentThrottleBucket(loginFailures, key, env.AUTH_LOGIN_WINDOW_SECONDS, now);
}

function currentPasswordResetBucket(key: string, now = Date.now()): AuthThrottleBucket {
  return currentThrottleBucket(
    passwordResetRequests,
    key,
    env.AUTH_PASSWORD_RESET_WINDOW_SECONDS,
    now,
  );
}
