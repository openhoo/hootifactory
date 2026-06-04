import { describe, expect, test } from "bun:test";
import { packageSearchLikePattern } from "./queries";

describe("package query helpers", () => {
  test("escapes wildcard characters in package search text", () => {
    expect(packageSearchLikePattern("left%_\\right")).toBe("%left\\%\\_\\\\right%");
  });
});
