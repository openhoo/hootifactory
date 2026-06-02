import { describe, expect, test } from "bun:test";
import {
  buildCargoOwnersBody,
  buildCargoOwnersUpdateBody,
  cargoOwnerId,
  parseCargoOwnersRequest,
} from "./cargo-owners";

describe("Cargo owner helpers", () => {
  test("maps repository users to stable Cargo owner records", () => {
    expect(cargoOwnerId("12345678-90ab-cdef-0000-000000000000")).toBe(0x12345678);
    expect(
      buildCargoOwnersBody([
        { id: "12345678-90ab-cdef-0000-000000000000", login: "alice", name: "Alice" },
        { id: "12345678-90ab-cdef-0000-000000000000", login: "alice", name: "Alice" },
        { id: "abcdef12-0000-0000-0000-000000000000", login: "bob", name: null },
      ]),
    ).toEqual({
      users: [
        { id: 0x12345678, login: "alice", name: "Alice" },
        { id: 0xabcdef12, login: "bob", name: null },
      ],
    });
  });

  test("parses owner mutation request bodies", async () => {
    const body = await parseCargoOwnersRequest(
      new Request("https://registry.test/api/v1/crates/hoot/owners", {
        method: "PUT",
        body: JSON.stringify({ users: ["alice", "team:dev"] }),
      }),
    );

    expect(body).toEqual({ users: ["alice", "team:dev"] });
  });

  test("rejects invalid owner mutation request bodies", async () => {
    await expect(
      parseCargoOwnersRequest(
        new Request("https://registry.test/api/v1/crates/hoot/owners", {
          method: "PUT",
          body: "not json",
        }),
      ),
    ).rejects.toMatchObject({ code: "MANIFEST_INVALID" });

    await expect(
      parseCargoOwnersRequest(
        new Request("https://registry.test/api/v1/crates/hoot/owners", {
          method: "PUT",
          body: JSON.stringify({ users: [""] }),
        }),
      ),
    ).rejects.toMatchObject({ code: "MANIFEST_INVALID" });
  });

  test("builds owner mutation acknowledgement messages", () => {
    expect(buildCargoOwnersUpdateBody(2, "add")).toEqual({
      ok: true,
      msg: "2 requested owner(s) added; crate owners are managed through Hootifactory repository permissions",
    });
    expect(buildCargoOwnersUpdateBody(1, "remove")).toEqual({
      ok: true,
      msg: "1 requested owner(s) removed; crate owners are managed through Hootifactory repository permissions",
    });
  });
});
