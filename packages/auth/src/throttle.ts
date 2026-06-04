import { createHash } from "node:crypto";
import { authThrottleBuckets, db, eq, lt, sql } from "@hootifactory/db";

export interface SharedAuthThrottleBucket {
  count: number;
  resetAt: number;
}

export type SharedAuthThrottleResult =
  | { throttled: false; bucket: SharedAuthThrottleBucket }
  | { throttled: true; retryAfter: number; bucket: SharedAuthThrottleBucket };

export async function consumeSharedAuthThrottleBucket(input: {
  scope: string;
  key: string;
  windowSeconds: number;
  maxAttempts: number;
  now?: number;
}): Promise<SharedAuthThrottleResult> {
  const now = input.now ?? Date.now();
  const nowDate = new Date(now);
  const resetAtDate = new Date(now + input.windowSeconds * 1000);
  const bucketHash = throttleBucketHash(input.scope, input.key);

  const [row] = await db
    .insert(authThrottleBuckets)
    .values({
      bucketHash,
      scope: input.scope,
      count: 1,
      resetAt: resetAtDate,
    })
    .onConflictDoUpdate({
      target: authThrottleBuckets.bucketHash,
      set: {
        count: sql<number>`case when ${authThrottleBuckets.resetAt} <= ${nowDate} then 1 else ${authThrottleBuckets.count} + 1 end`,
        resetAt: sql<Date>`case when ${authThrottleBuckets.resetAt} <= ${nowDate} then ${resetAtDate} else ${authThrottleBuckets.resetAt} end`,
        updatedAt: nowDate,
      },
    })
    .returning({
      count: authThrottleBuckets.count,
      resetAt: authThrottleBuckets.resetAt,
    });

  const bucket = {
    count: row?.count ?? 1,
    resetAt: (row?.resetAt ?? resetAtDate).getTime(),
  };
  if (bucket.count <= input.maxAttempts) return { throttled: false, bucket };
  return { throttled: true, retryAfter: retryAfterSeconds(bucket, now), bucket };
}

export async function clearSharedAuthThrottleBucket(scope: string, key: string): Promise<void> {
  await db
    .delete(authThrottleBuckets)
    .where(eq(authThrottleBuckets.bucketHash, throttleBucketHash(scope, key)));
}

export async function sweepExpiredAuthThrottleBuckets(now = Date.now()): Promise<number> {
  const deleted = await db
    .delete(authThrottleBuckets)
    .where(lt(authThrottleBuckets.resetAt, new Date(now)))
    .returning({ bucketHash: authThrottleBuckets.bucketHash });
  return deleted.length;
}

export function retryAfterSeconds(bucket: SharedAuthThrottleBucket, now = Date.now()): number {
  return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
}

function throttleBucketHash(scope: string, key: string): string {
  return createHash("sha256").update(scope).update("\0").update(key).digest("hex");
}
