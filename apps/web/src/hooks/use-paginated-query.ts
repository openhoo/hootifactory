import {
  keepPreviousData,
  type QueryKey,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";

export interface UsePaginatedQueryOptions<TData, TItem> {
  /** Stable query-key prefix; the current limit is appended automatically. */
  queryKey: QueryKey;
  /** Fetch one page. `offset` is always 0 — this is a growing "load more" window. */
  queryFn: (args: { limit: number; offset: number }) => Promise<TData>;
  /** Extract the row list from a page. */
  selectItems: (data: TData) => TItem[];
  /** Extract the total row count from a page. */
  selectTotal: (data: TData) => number;
  pageSize?: number;
  /** Hard ceiling on the window size (e.g. a server-enforced max). */
  maxLimit?: number;
  /**
   * When this value changes the window resets to the first page. Pass the org id
   * (or repo id) so switching context never reuses the previous view's limit.
   */
  resetKey?: unknown;
  enabled?: boolean;
  /** Shown as the total while the first page is still loading. */
  fallbackTotal?: number;
  /** Keep showing the previous page's rows while the next one loads. */
  placeholderData?: boolean;
}

export interface UsePaginatedQueryResult<TData, TItem> {
  query: UseQueryResult<TData>;
  items: TItem[];
  total: number;
  canLoadMore: boolean;
  loadMore: () => void;
  limit: number;
}

/**
 * A "load more" paginated query: owns the growing limit, resets it when
 * `resetKey` changes, and derives `items`/`total`/`canLoadMore` so callers stop
 * re-implementing the same window arithmetic per list.
 */
export function usePaginatedQuery<TData, TItem>(
  options: UsePaginatedQueryOptions<TData, TItem>,
): UsePaginatedQueryResult<TData, TItem> {
  const pageSize = options.pageSize ?? 50;
  const [limit, setLimit] = useState(pageSize);

  // resetKey (org/repo switch) is the intentional reset trigger; it is not read
  // inside the effect body, so exhaustive-deps would wrongly flag it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is the reset trigger
  useEffect(() => {
    setLimit(pageSize);
  }, [options.resetKey, pageSize]);

  const query = useQuery({
    queryKey: [...options.queryKey, limit],
    queryFn: () => options.queryFn({ limit, offset: 0 }),
    enabled: options.enabled,
    ...(options.placeholderData ? { placeholderData: keepPreviousData } : {}),
  });

  const items = query.data ? options.selectItems(query.data) : [];
  const total = query.data ? options.selectTotal(query.data) : (options.fallbackTotal ?? 0);
  const atMax = options.maxLimit !== undefined && limit >= options.maxLimit;
  const canLoadMore = items.length < total && !atMax;
  const loadMore = () =>
    setLimit((current) =>
      options.maxLimit !== undefined ? Math.min(current + pageSize, options.maxLimit) : current + pageSize,
    );

  return { query, items, total, canLoadMore, loadMore, limit };
}
