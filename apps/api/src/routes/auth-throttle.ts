import {
  authenticateUserPassword,
  clearSharedAuthThrottleBucket,
  consumeSharedAuthThrottleBucket,
  type Principal,
} from "@hootifactory/auth";
import { env } from "@hootifactory/config";

export interface AuthThrottleBucket {
  count: number;
  resetAt: number;
}

const LOGIN_IDENTITY_SCOPE = "login:identity";
const LOGIN_CLIENT_SCOPE = "login:client";
const REGISTRATION_USERNAME_SCOPE = "registration:username";
const REGISTRATION_EMAIL_SCOPE = "registration:email";
const PASSWORD_RESET_IDENTITY_SCOPE = "password-reset:identity";
const PASSWORD_RESET_CLIENT_SCOPE = "password-reset:client";

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

export function registrationUsernameThrottleKey(username: string): string {
  return identityThrottleKey(username);
}

export function registrationEmailThrottleKey(email: string): string {
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

export async function consumeLoginAttempt(
  username: string,
  ip: string,
): Promise<
  { throttled: false; bucket: AuthThrottleBucket } | { throttled: true; retryAfter: number }
> {
  const identityThrottle = await consumeSharedAuthThrottleBucket({
    scope: LOGIN_IDENTITY_SCOPE,
    key: loginIdentityThrottleKey(username),
    windowSeconds: env.AUTH_LOGIN_WINDOW_SECONDS,
    maxAttempts: env.AUTH_LOGIN_MAX_ATTEMPTS,
  });
  if (identityThrottle.throttled) return identityThrottle;

  const clientThrottle = await consumeSharedAuthThrottleBucket({
    scope: LOGIN_CLIENT_SCOPE,
    key: loginThrottleKey(username, ip),
    windowSeconds: env.AUTH_LOGIN_WINDOW_SECONDS,
    maxAttempts: env.AUTH_LOGIN_MAX_ATTEMPTS,
  });
  if (clientThrottle.throttled) return clientThrottle;
  return { throttled: false, bucket: identityThrottle.bucket };
}

export async function consumePasswordResetRequest(
  email: string,
  ip: string,
): Promise<
  { throttled: false; bucket: AuthThrottleBucket } | { throttled: true; retryAfter: number }
> {
  const identityThrottle = await consumeSharedAuthThrottleBucket({
    scope: PASSWORD_RESET_IDENTITY_SCOPE,
    key: passwordResetIdentityThrottleKey(email),
    windowSeconds: env.AUTH_PASSWORD_RESET_WINDOW_SECONDS,
    maxAttempts: env.AUTH_PASSWORD_RESET_MAX_ATTEMPTS,
  });
  if (identityThrottle.throttled) return identityThrottle;

  const clientThrottle = await consumeSharedAuthThrottleBucket({
    scope: PASSWORD_RESET_CLIENT_SCOPE,
    key: passwordResetThrottleKey(email, ip),
    windowSeconds: env.AUTH_PASSWORD_RESET_WINDOW_SECONDS,
    maxAttempts: env.AUTH_PASSWORD_RESET_MAX_ATTEMPTS,
  });
  if (clientThrottle.throttled) return clientThrottle;
  return { throttled: false, bucket: identityThrottle.bucket };
}

export async function consumeRegistrationAttempt(
  username: string,
  email: string,
): Promise<
  { throttled: false; bucket: AuthThrottleBucket } | { throttled: true; retryAfter: number }
> {
  const usernameThrottle = await consumeSharedAuthThrottleBucket({
    scope: REGISTRATION_USERNAME_SCOPE,
    key: registrationUsernameThrottleKey(username),
    windowSeconds: env.AUTH_REGISTRATION_WINDOW_SECONDS,
    maxAttempts: env.AUTH_REGISTRATION_MAX_ATTEMPTS,
  });
  if (usernameThrottle.throttled) return usernameThrottle;

  const emailThrottle = await consumeSharedAuthThrottleBucket({
    scope: REGISTRATION_EMAIL_SCOPE,
    key: registrationEmailThrottleKey(email),
    windowSeconds: env.AUTH_REGISTRATION_WINDOW_SECONDS,
    maxAttempts: env.AUTH_REGISTRATION_MAX_ATTEMPTS,
  });
  if (emailThrottle.throttled) return emailThrottle;
  return { throttled: false, bucket: emailThrottle.bucket };
}

export async function clearLoginFailureAttempt(username: string, ip: string): Promise<void> {
  await Promise.all([
    clearSharedAuthThrottleBucket(LOGIN_IDENTITY_SCOPE, loginIdentityThrottleKey(username)),
    clearSharedAuthThrottleBucket(LOGIN_CLIENT_SCOPE, loginThrottleKey(username, ip)),
  ]);
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
  const throttle = await consumeLoginAttempt(username, ip);
  if (throttle.throttled) return { kind: "throttled", retryAfter: throttle.retryAfter };

  const principal = await verify(username, password);
  if (principal?.kind === "user") {
    await clearLoginFailureAttempt(username, ip);
    return { kind: "authenticated", principal };
  }

  return { kind: "invalid", failure: throttle.bucket };
}

function throttleKey(identity: string, ip: string): string {
  return `${identity.trim().toLowerCase()}\0${ip}`;
}

function identityThrottleKey(identity: string): string {
  return identity.trim().toLowerCase();
}
