import { describe, expect, test } from "bun:test";
import { pubBadRequest, pubErrorResponse, pubNotFound } from "./pub-errors";

describe("pub error envelopes", () => {
  test("pubErrorResponse renders the {error:{code,message}} shape with the status", async () => {
    const res = pubErrorResponse("Teapot", "boom", 418);
    expect(res.status).toBe(418);
    expect(res.headers.get("content-type")).toBe("application/vnd.pub.v2+json");
    expect(await res.json()).toEqual({ error: { code: "Teapot", message: "boom" } });
  });

  test("pubNotFound is a 404 NotFound envelope", async () => {
    const res = pubNotFound("missing package");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "NotFound", message: "missing package" } });
  });

  test("pubBadRequest is a 400 InvalidInput envelope", async () => {
    const res = pubBadRequest("bad name");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "InvalidInput", message: "bad name" } });
  });
});
