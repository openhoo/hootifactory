import { describe, expect, test } from "bun:test";
import { puppetBadRequest, puppetErrorResponse, puppetNotFound } from "./puppet-errors";

describe("puppet error envelopes", () => {
  test("puppetErrorResponse renders the Forge {message,errors} shape with the status", async () => {
    const res = puppetErrorResponse("boom", 418);
    expect(res.status).toBe(418);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await res.json()).toEqual({ message: "boom", errors: ["boom"] });
  });

  test("puppetNotFound is a 404 envelope", async () => {
    const res = puppetNotFound("missing module");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "missing module", errors: ["missing module"] });
  });

  test("puppetBadRequest is a 400 envelope", async () => {
    const res = puppetBadRequest("bad slug");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ message: "bad slug", errors: ["bad slug"] });
  });
});
