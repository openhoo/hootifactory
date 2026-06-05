import { describe, expect, test } from "bun:test";
import {
  listLivePackageVersionNames,
  listLivePackageVersions,
  packageSearchLikePattern,
} from "./queries";

describe("package query helpers", () => {
  test("escapes wildcard characters in package search text", () => {
    expect(packageSearchLikePattern("left%_\\right")).toBe("%left\\%\\_\\\\right%");
  });
});

/**
 * The live version reads return the drizzle query builder (a thenable), so the
 * ORDER BY contract is assertable from the generated SQL without a database and,
 * crucially, independent of the query plan. createdAt is not unique — versions
 * published in the same millisecond tie — so each read MUST end in the unique
 * `id` tiebreak; otherwise Postgres can return tied rows in plan/heap order that
 * differs between two identical requests, and the metadata builders serialize
 * that order verbatim, flaking the gzip-vs-identity byte-equality checks. A
 * DB-level test can't guard this: in isolation the partial index masks the
 * defect by returning ordered rows anyway.
 */
function sqlOf(buildable: unknown): string {
  return (buildable as { toSQL(): { sql: string } }).toSQL().sql;
}

function orderByClause(buildable: unknown): string {
  const sql = sqlOf(buildable).toLowerCase();
  const at = sql.indexOf("order by");
  expect(at, `query must carry an ORDER BY: ${sql}`).toBeGreaterThanOrEqual(0);
  return sql.slice(at);
}

const PKG = "00000000-0000-0000-0000-000000000000";

describe("live version reads use a total, unique ORDER BY", () => {
  test("listLivePackageVersions default orders by created_at then the id tiebreak (asc)", () => {
    const clause = orderByClause(listLivePackageVersions(PKG));
    expect(clause).toContain("created_at");
    expect(clause).toContain("asc");
    // the unique id column must come AFTER created_at, making the order total
    expect(clause.indexOf('"id"')).toBeGreaterThan(clause.indexOf("created_at"));
  });

  test("listLivePackageVersions asc resolves to the same total order as the default", () => {
    expect(sqlOf(listLivePackageVersions(PKG, { orderByCreated: "asc" }))).toBe(
      sqlOf(listLivePackageVersions(PKG)),
    );
  });

  test("listLivePackageVersions desc orders by created_at then the id tiebreak (desc)", () => {
    const clause = orderByClause(listLivePackageVersions(PKG, { orderByCreated: "desc" }));
    expect(clause).toContain("desc");
    expect(clause.indexOf('"id"')).toBeGreaterThan(clause.indexOf("created_at"));
  });

  test("listLivePackageVersionNames default ends in the id tiebreak", () => {
    const clause = orderByClause(listLivePackageVersionNames(PKG));
    expect(clause.indexOf('"id"')).toBeGreaterThan(clause.indexOf("created_at"));
  });
});
