import { describe, expect, test } from "bun:test";
import { createTestRegistryContext } from "../testing";
import { bearerAuthChallenge, registryBearerAuthChallenge } from "./auth";

describe("registry auth helpers", () => {
  test("builds simple bearer challenges", () => {
    expect(bearerAuthChallenge()).toEqual({ header: 'Bearer realm="hootifactory"', status: 401 });
  });

  test("builds OCI registry bearer challenges from permissions", () => {
    const ctx = createTestRegistryContext({ baseUrl: "https://registry.example.test" });

    expect(
      registryBearerAuthChallenge({
        ctx,
        permission: { action: "write", repositoryName: "acme/images/api" },
      }),
    ).toEqual({
      header:
        'Bearer realm="https://registry.example.test/token",service="hootifactory",scope="repository:acme/images/api:push,pull"',
      status: 401,
    });
  });

  test("escapes quote/comma injection in the repository name", () => {
    const ctx = createTestRegistryContext({ baseUrl: "https://registry.example.test" });

    // A crafted name containing a `"` (and a `,`) must not break out of the
    // scope quoted-string to inject competing realm/service/scope directives.
    const { header } = registryBearerAuthChallenge({
      ctx,
      permission: { action: "read", repositoryName: 'evil",scope="repository:victim/secret:pull' },
    });

    expect(header).toBe(
      'Bearer realm="https://registry.example.test/token",service="hootifactory",' +
        'scope="repository:evil\\",scope=\\"repository:victim/secret:pull:pull"',
    );
    // The injected `"` and the directive-shaped substring must be escaped, so no
    // *second* (forged) scope directive is introduced.
    expect(header).toContain('repository:evil\\",scope=\\"repository');
    // Once backslash-escaped quotes are removed, the only remaining `"`
    // characters are the three directive-delimiting pairs (6 quotes): no stray
    // quote escapes the quoted-string to start a new directive.
    const delimiterQuotes = header.replace(/\\"/g, "").match(/"/g)?.length ?? 0;
    expect(delimiterQuotes).toBe(6);
  });

  test("leaves normal repository names unchanged", () => {
    const ctx = createTestRegistryContext({ baseUrl: "https://registry.example.test" });

    expect(
      registryBearerAuthChallenge({
        ctx,
        permission: { action: "read", repositoryName: "acme/images/api" },
      }).header,
    ).toBe(
      'Bearer realm="https://registry.example.test/token",service="hootifactory",scope="repository:acme/images/api:pull"',
    );
  });
});
