import { authenticateUserPassword, type Principal } from "@hootifactory/auth";
import { env } from "@hootifactory/config";

export interface AuthThrottleBucket {
  count: number;
  resetAt: number;
}

const loginFailures = new Map<string, AuthThrottleBucket>();
const loginIdentityFailures = new Map<string, AuthThrottleBucket>();
const passwordResetRequests = new Map<string, AuthThrottleBucket>();
const passwordResetIdentityRequests = new Map<string, AuthThrottleBucket>();

export function loginThrottleKey(username: string, ip: string): string {
  return throttleKey(username, ip);
}

export function loginIdentityThrottleKey(username: string): string {
  return identityThrottleKey(username);
}

export function passwordResetThrottleKey(email: string, ip: string): string {
  return throttleKey(email, ip);
}

export function passwordResetIdentityThrottleKey(email: string): string {
  return identityThrottleKey(email);
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
  return loginBucketIsThrottled(loginFailures, key);
}

export function loginRequestIsThrottled(
  username: string,
  ip: string,
): { throttled: false } | { throttled: true; retryAfter: number } {
  const identityThrottle = loginBucketIsThrottled(
    loginIdentityFailures,
    loginIdentityThrottleKey(username),
  );
  if (identityThrottle.throttled) return identityThrottle;
  return loginIsThrottled(loginThrottleKey(username, ip));
}

export function recordLoginFailure(key: string): AuthThrottleBucket {
  const bucket = currentLoginBucket(key);
  bucket.count += 1;
  return bucket;
}

export function recordLoginFailureAttempt(username: string, ip: string): AuthThrottleBucket {
  const identityBucket = currentLoginBucket(
    loginIdentityThrottleKey(username),
    loginIdentityFailures,
  );
  identityBucket.count += 1;
  recordLoginFailure(loginThrottleKey(username, ip));
  return identityBucket;
}

export function passwordResetIsThrottled(
  key: string,
): { throttled: false } | { throttled: true; retryAfter: number } {
  return passwordResetBucketIsThrottled(passwordResetRequests, key);
}

export function passwordResetRequestIsThrottled(
  email: string,
  ip: string,
): { throttled: false } | { throttled: true; retryAfter: number } {
  const identityThrottle = passwordResetBucketIsThrottled(
    passwordResetIdentityRequests,
    passwordResetIdentityThrottleKey(email),
  );
  if (identityThrottle.throttled) return identityThrottle;
  return passwordResetIsThrottled(passwordResetThrottleKey(email, ip));
}

export function recordPasswordResetRequest(key: string): AuthThrottleBucket {
  const bucket = currentPasswordResetBucket(key);
  bucket.count += 1;
  return bucket;
}

export function recordPasswordResetRequestAttempt(email: string, ip: string): AuthThrottleBucket {
  const identityBucket = currentPasswordResetBucket(
    passwordResetIdentityThrottleKey(email),
    passwordResetIdentityRequests,
  );
  identityBucket.count += 1;
  recordPasswordResetRequest(passwordResetThrottleKey(email, ip));
  return identityBucket;
}

export function clearLoginFailures(key: string): void {
  loginFailures.delete(key);
}

export function clearLoginFailureAttempt(username: string, ip: string): void {
  clearLoginFailures(loginThrottleKey(username, ip));
  loginIdentityFailures.delete(loginIdentityThrottleKey(username));
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
  const throttle = loginRequestIsThrottled(username, ip);
  if (throttle.throttled) return { kind: "throttled", retryAfter: throttle.retryAfter };

  const principal = await verify(username, password);
  if (principal?.kind === "user") {
    clearLoginFailureAttempt(username, ip);
    return { kind: "authenticated", principal };
  }

  return { kind: "invalid", failure: recordLoginFailureAttempt(username, ip) };
}

function throttleKey(identity: string, ip: string): string {
  return `${identity.trim().toLowerCase()}\0${ip}`;
}

function identityThrottleKey(identity: string): string {
  return identity.trim().toLowerCase();
}

function loginBucketIsThrottled(
  buckets: Map<string, AuthThrottleBucket>,
  key: string,
): { throttled: false } | { throttled: true; retryAfter: number } {
  const bucket = currentLoginBucket(key, buckets);
  if (bucket.count < env.AUTH_LOGIN_MAX_ATTEMPTS) return { throttled: false };
  return { throttled: true, retryAfter: retryAfterSeconds(bucket) };
}

function passwordResetBucketIsThrottled(
  buckets: Map<string, AuthThrottleBucket>,
  key: string,
): { throttled: false } | { throttled: true; retryAfter: number } {
  const bucket = currentPasswordResetBucket(key, buckets);
  if (bucket.count < env.AUTH_PASSWORD_RESET_MAX_ATTEMPTS) return { throttled: false };
  return { throttled: true, retryAfter: retryAfterSeconds(bucket) };
}

function currentLoginBucket(
  key: string,
  buckets = loginFailures,
  now = Date.now(),
): AuthThrottleBucket {
  return currentThrottleBucket(buckets, key, env.AUTH_LOGIN_WINDOW_SECONDS, now);
}

function currentPasswordResetBucket(
  key: string,
  buckets = passwordResetRequests,
  now = Date.now(),
): AuthThrottleBucket {
  return currentThrottleBucket(buckets, key, env.AUTH_PASSWORD_RESET_WINDOW_SECONDS, now);
}
