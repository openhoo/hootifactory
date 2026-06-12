import { describe, expect, test } from "bun:test";
import { RegistryError, z, zodIssueTree } from "@hootifactory/core";
import { createTestRegistryContext, createTestRouteMatch } from "../testing";
import type { Permission } from "./adapter";
import {
  defineRegistryPlugin,
  type RegistryPermissionInput,
  registryAdapter,
  registryRouteParamDefaults,
  registryRoutes,
  validateRegistryRouteParams,
} from "./plugin";

const NameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/)
  .max(64);

function buildPluginWithParams(permissionLog: RegistryPermissionInput[]) {
  return registryAdapter("npm")
    .module({ capabilities: ["virtualizable"] })
    .routes((route) => [
      route
        .get("/api/:crate/:version/download", "download")
        .params({
          crate: { schema: NameSchema, code: "NAME_INVALID", message: "invalid crate name" },
          version: {
            schema: z.string().regex(/^\d+\.\d+\.\d+$/),
            code: "MANIFEST_INVALID",
            message: "invalid crate version",
          },
        })
        .permission((input: RegistryPermissionInput): Permission => {
          // The builder probes permission callbacks with its DSL once at build
          // time; only record real runtime resolutions (which carry params).
          if (typeof (input as { params?: unknown }).params !== "object") {
            return { action: "read" };
          }
          permissionLog.push(input);
          return { action: "read", resource: { type: "package", packageName: input.params.crate } };
        })
        .handle(({ params }) => Response.json({ params })),
      route.get("/raw/:anything", "raw").handle(({ params }) => Response.json({ params })),
    ])
    .build();
}

describe("route-level .params() schemas", () => {
  test("invalid params short-circuit requiredPermission BEFORE the permission resolver", () => {
    const permissionLog: RegistryPermissionInput[] = [];
    const plugin = buildPluginWithParams(permissionLog);
    const [download] = plugin.routes();
    const match = createTestRouteMatch(download!, { crate: "NOT VALID!", version: "1.0.0" });

    let thrown: unknown;
    try {
      plugin.requiredPermission("GET", match, createTestRegistryContext());
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RegistryError);
    const err = thrown as RegistryError;
    expect(err.status).toBe(400);
    expect(err.code).toBe("NAME_INVALID");
    expect(err.message).toBe("invalid crate name");
    expect(permissionLog).toHaveLength(0);
  });

  test("error shape matches parseRegistryInput byte-for-byte (incl. zod issue tree detail)", () => {
    const permissionLog: RegistryPermissionInput[] = [];
    const plugin = buildPluginWithParams(permissionLog);
    const [download] = plugin.routes();
    const match = createTestRouteMatch(download!, { crate: "left-pad", version: "not-semver" });

    let thrown: RegistryError | undefined;
    try {
      plugin.requiredPermission("GET", match, createTestRegistryContext());
    } catch (err) {
      thrown = err as RegistryError;
    }
    const parsed = z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .safeParse("not-semver");
    expect(parsed.success).toBe(false);
    if (parsed.success || !thrown) throw new Error("expected failures");
    expect(thrown.code).toBe("MANIFEST_INVALID");
    expect(thrown.message).toBe("invalid crate version");
    expect(thrown.detail).toEqual(zodIssueTree(parsed.error));
    // The rendered response is identical to parseRegistryInput's RegistryError.
    const reference = new RegistryError(
      400,
      "MANIFEST_INVALID",
      "invalid crate version",
      zodIssueTree(parsed.error),
    );
    expect(thrown.toResponse().status).toBe(reference.toResponse().status);
  });

  test("handle() also validates and rejects with the same RegistryError", async () => {
    const permissionLog: RegistryPermissionInput[] = [];
    const plugin = buildPluginWithParams(permissionLog);
    const [download] = plugin.routes();
    const match = createTestRouteMatch(download!, { crate: "NOT VALID!", version: "1.0.0" });

    expect(
      plugin.handle(match, new Request("https://registry.example.test/x"), {
        ...createTestRegistryContext(),
      }),
    ).rejects.toMatchObject({ name: "RegistryError", status: 400, code: "NAME_INVALID" });
  });

  test("transformed outputs are visible to both the permission resolver and the handler", async () => {
    const permissionLog: RegistryPermissionInput[] = [];
    const plugin = registryAdapter("npm")
      .module({ capabilities: ["virtualizable"] })
      .routes((route) => [
        route
          .get("/:pkg", "metadata")
          .params({
            pkg: z
              .string()
              .min(1)
              .transform((value) => value.toLowerCase()),
          })
          .permission((input: RegistryPermissionInput): Permission => {
            if (typeof (input as { params?: unknown }).params === "object") {
              permissionLog.push(input);
            }
            return { action: "read" };
          })
          .handle(({ params, match }) => Response.json({ pkg: params.pkg, raw: match.params.pkg })),
      ])
      .build();
    const [entry] = plugin.routes();
    const match = createTestRouteMatch(entry!, { pkg: "Left-Pad" });

    plugin.requiredPermission("GET", match, createTestRegistryContext());
    expect(permissionLog[0]?.params.pkg).toBe("left-pad");

    const res = await plugin.handle(
      match,
      new Request("https://registry.example.test/Left-Pad"),
      createTestRegistryContext(),
    );
    // Handler sees the schema output; the raw match is untouched.
    expect(await res.json()).toEqual({ pkg: "left-pad", raw: "Left-Pad" });
    expect(match.params.pkg).toBe("Left-Pad");
  });

  test("routes without .params() are unchanged (raw params, no validation)", async () => {
    const permissionLog: RegistryPermissionInput[] = [];
    const plugin = buildPluginWithParams(permissionLog);
    const [, raw] = plugin.routes();
    const match = createTestRouteMatch(raw!, { anything: "ANY thing!!" });

    expect(plugin.requiredPermission("GET", match, createTestRegistryContext())).toEqual({
      action: "read",
    });
    const res = await plugin.handle(
      match,
      new Request("https://registry.example.test/raw/x"),
      createTestRegistryContext(),
    );
    expect(await res.json()).toEqual({ params: { anything: "ANY thing!!" } });
  });

  test("params spec never leaks into the compiled RouteEntry list", () => {
    const plugin = buildPluginWithParams([]);
    const [download] = plugin.routes();
    expect(download).toEqual({
      method: "GET",
      pattern: "/api/:crate/:version/download",
      handlerId: "download",
    });
  });

  test("route-level defaults apply under per-param overrides", () => {
    const shape = registryRouteParamDefaults(
      {
        user: NameSchema,
        box: { schema: NameSchema, message: "invalid box name" },
      },
      { code: "NAME_INVALID", message: "invalid segment" },
    );
    expect(() => validateRegistryRouteParams(shape, { user: "BAD!", box: "ok" })).toThrow(
      expect.objectContaining({ code: "NAME_INVALID", message: "invalid segment" }),
    );
    expect(() => validateRegistryRouteParams(shape, { user: "ok", box: "BAD!" })).toThrow(
      expect.objectContaining({ code: "NAME_INVALID", message: "invalid box name" }),
    );
    expect(validateRegistryRouteParams(shape, { user: "ok", box: "fine" })).toEqual({
      user: "ok",
      box: "fine",
    });
  });

  test("defaults fall back to parseRegistryInput's UNSUPPORTED/invalid request", () => {
    expect(() => validateRegistryRouteParams({ pkg: NameSchema }, { pkg: "BAD!" })).toThrow(
      expect.objectContaining({ status: 400, code: "UNSUPPORTED", message: "invalid request" }),
    );
  });

  test("plain defineRegistryPlugin routes accept params in options", () => {
    const plugin = defineRegistryPlugin({
      id: "npm",
      capabilities: {
        contentAddressable: false,
        resumableUploads: false,
        proxyable: false,
        virtualizable: true,
      },
      routes: [
        registryRoutes.get("/:pkg", "metadata", ({ params }) => Response.json(params), {
          params: { pkg: { schema: NameSchema, code: "NAME_INVALID" } },
        }),
      ],
    });
    const [entry] = plugin.routes();
    const match = createTestRouteMatch(entry!, { pkg: "Bad Name" });
    expect(() => plugin.requiredPermission("GET", match, createTestRegistryContext())).toThrow(
      expect.objectContaining({ code: "NAME_INVALID" }),
    );
  });
});
