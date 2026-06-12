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
  test("invalid params in handle() reject with RegistryError", async () => {
    const permissionLog: RegistryPermissionInput[] = [];
    const plugin = buildPluginWithParams(permissionLog);
    const [download] = plugin.routes();
    const match = createTestRouteMatch(download!, { crate: "NOT VALID!", version: "1.0.0" });

    const ctx = createTestRegistryContext();
    // requiredPermission no longer validates params; it returns a permission
    // built from raw params (the permission resolver maps crate -> packageName).
    const perm = plugin.requiredPermission("GET", match, ctx);
    expect(perm).toEqual({
      action: "read",
      resource: { type: "package", packageName: "NOT VALID!" },
    });
    // handle() still validates and throws.
    await expect(
      plugin.handle(match, new Request("https://registry.example.test/x"), ctx),
    ).rejects.toMatchObject({ status: 400, code: "NAME_INVALID", message: "invalid crate name" });
    // The permission resolver runs with raw params since validation moved to handle().
    expect(permissionLog).toHaveLength(1);
  });

  test("error shape matches parseRegistryInput byte-for-byte (incl. zod issue tree detail)", async () => {
    const permissionLog: RegistryPermissionInput[] = [];
    const plugin = buildPluginWithParams(permissionLog);
    const [download] = plugin.routes();
    const match = createTestRouteMatch(download!, { crate: "left-pad", version: "not-semver" });

    const ctx = createTestRegistryContext();
    let thrown: RegistryError | undefined;
    try {
      await plugin.handle(match, new Request("https://registry.example.test/x"), ctx);
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

  test("transformed outputs are visible to the handler", async () => {
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

    // requiredPermission gets raw params; validation/normalization happens in handle().
    plugin.requiredPermission("GET", match, createTestRegistryContext());
    expect(permissionLog[0]?.params.pkg).toBe("Left-Pad");

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

  test("plain defineRegistryPlugin routes accept params in options", async () => {
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
    // requiredPermission no longer validates params; handle() catches bad params.
    expect(plugin.requiredPermission("GET", match, createTestRegistryContext())).toEqual({
      action: "read",
    });
    await expect(
      plugin.handle(
        match,
        new Request("https://registry.example.test/x"),
        createTestRegistryContext(),
      ),
    ).rejects.toMatchObject({ code: "NAME_INVALID" });
  });
});
