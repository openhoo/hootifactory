import { execFileSync } from "node:child_process";
import { createSign, generateKeyPairSync } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { expect, test } from "@playwright/test";
import { anonContext, setupOwner } from "./helpers";

const WEB = `http://127.0.0.1:${process.env.E2E_WEB_PORT ?? 5174}`;
const OIDC_PORT = Number(process.env.E2E_OIDC_PORT ?? 4578);
const ISSUER = `http://127.0.0.1:${OIDC_PORT}`;
const CLIENT_ID = "hootifactory-e2e";
const CLIENT_SECRET = "e2e-secret";
const ORG_SLUG = "oidc-e2e";
const TEST_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgres://hootifactory:hootifactory@localhost:5432/hootifactory_test";

function b64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function createOidcLinkToken(input: {
  userId: string;
  email: string;
  orgSlug: string;
  returnTo: string;
}): string {
  const output = execFileSync(
    "bun",
    [
      "-e",
      [
        'import { createAuthEmailToken } from "@hootifactory/auth";',
        "const { secret } = await createAuthEmailToken({",
        '  purpose: "oidc_link",',
        "  userId: process.env.USER_ID,",
        "  email: process.env.EMAIL,",
        "  ttlSeconds: 300,",
        "  metadata: {",
        "    returnTo: process.env.RETURN_TO,",
        "    claims: {",
        '      issuer: "https://idp.example.test",',
        "      subject: process.env.SUBJECT,",
        "      email: process.env.EMAIL,",
        "      emailVerified: true,",
        '      username: "linked-e2e",',
        '      displayName: "Linked E2E",',
        '      groups: ["oidc-admins"],',
        '      grants: [{ org: process.env.ORG_SLUG, group: "oidc-admins", groups: ["oidc-admins"] }],',
        "    },",
        "  },",
        "});",
        "console.log(JSON.stringify({ secret }));",
      ].join("\n"),
    ],
    {
      env: {
        ...process.env,
        DATABASE_URL: TEST_DATABASE_URL,
        USER_ID: input.userId,
        EMAIL: input.email,
        ORG_SLUG: input.orgSlug,
        RETURN_TO: input.returnTo,
        SUBJECT: crypto.randomUUID(),
      },
      stdio: "pipe",
      encoding: "utf8",
    },
  );
  return (JSON.parse(output) as { secret: string }).secret;
}

function seedOidcManagedGroupPermissions(): void {
  execFileSync(
    "bun",
    [
      "-e",
      [
        'import { and, db, eq, groups, organizations, permissionGrants } from "@hootifactory/db";',
        'const groupSlug = "oidc-admins";',
        "const [org] = await db.select().from(organizations).where(eq(organizations.slug, process.env.ORG_SLUG)).limit(1);",
        'if (!org) throw new Error("OIDC E2E org does not exist");',
        "const externalKey = JSON.stringify([process.env.ISSUER, groupSlug]);",
        "await db.transaction(async (tx) => {",
        "  const [group] = await tx.insert(groups).values({",
        "    orgId: org.id,",
        "    slug: groupSlug,",
        "    displayName: groupSlug,",
        '    managedBy: "oidc",',
        "    externalKey,",
        "  }).onConflictDoUpdate({",
        "    target: [groups.orgId, groups.slug],",
        '    set: { managedBy: "oidc", externalKey },',
        "  }).returning();",
        '  if (!group) throw new Error("OIDC E2E group was not returned");',
        "  await tx.delete(permissionGrants).where(and(eq(permissionGrants.orgId, org.id), eq(permissionGrants.groupId, group.id)));",
        "  await tx.insert(permissionGrants).values([",
        '    { orgId: org.id, groupId: group.id, permission: "org.read", source: "e2e" },',
        '    { orgId: org.id, groupId: group.id, permission: "repository.read", source: "e2e", repositoryPattern: "*" },',
        "  ]);",
        "});",
      ].join("\n"),
    ],
    {
      env: {
        ...process.env,
        DATABASE_URL: TEST_DATABASE_URL,
        ORG_SLUG,
        ISSUER,
      },
      stdio: "pipe",
      encoding: "utf8",
    },
  );
}

function csrfFromConfirmationPage(html: string): string {
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  if (!csrf) throw new Error("OIDC link confirmation page did not render a CSRF token");
  return csrf;
}

class FakeOidcProvider {
  private readonly keypair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  private readonly codes = new Map<string, { nonce: string }>();
  private server: Server | null = null;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((err) => {
        res.statusCode = 500;
        res.end(err instanceof Error ? err.message : String(err));
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(OIDC_PORT, "127.0.0.1", () => resolve());
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server!.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", ISSUER);
    if (url.pathname === "/.well-known/openid-configuration") {
      return this.json(res, {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        userinfo_endpoint: `${ISSUER}/userinfo`,
        jwks_uri: `${ISSUER}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
      });
    }
    if (url.pathname === "/jwks") {
      const jwk = this.keypair.publicKey.export({ format: "jwk" });
      return this.json(res, { keys: [{ ...jwk, kid: "e2e", use: "sig", alg: "RS256" }] });
    }
    if (url.pathname === "/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      const nonce = url.searchParams.get("nonce");
      if (!redirectUri || !state || !nonce) return this.text(res, 400, "bad auth request");
      const code = crypto.randomUUID();
      this.codes.set(code, { nonce });
      const redirect = new URL(redirectUri);
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("state", state);
      res.statusCode = 302;
      res.setHeader("location", redirect.href);
      res.end();
      return;
    }
    if (url.pathname === "/token") {
      const params = new URLSearchParams(await body(req));
      const code = params.get("code") ?? "";
      const clientId = params.get("client_id");
      const clientSecret = params.get("client_secret");
      const saved = this.codes.get(code);
      if (!saved || clientId !== CLIENT_ID || clientSecret !== CLIENT_SECRET) {
        return this.text(res, 400, "bad token request");
      }
      return this.json(res, {
        access_token: "fake-access",
        token_type: "Bearer",
        expires_in: 300,
        id_token: this.idToken(saved.nonce),
      });
    }
    if (url.pathname === "/userinfo") {
      return this.json(res, this.claims());
    }
    return this.text(res, 404, "not found");
  }

  private claims(nonce?: string): Record<string, unknown> {
    return {
      iss: ISSUER,
      sub: "oidc-e2e-user",
      aud: CLIENT_ID,
      exp: Math.floor(Date.now() / 1000) + 300,
      iat: Math.floor(Date.now() / 1000),
      nonce,
      email: "oidc-e2e@example.test",
      email_verified: true,
      preferred_username: "oidc-e2e",
      name: "OIDC E2E",
      groups: ["oidc-admins"],
    };
  }

  private idToken(nonce: string): string {
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "e2e" }));
    const payload = b64url(JSON.stringify(this.claims(nonce)));
    const input = `${header}.${payload}`;
    const signature = createSign("RSA-SHA256").update(input).sign(this.keypair.privateKey);
    return `${input}.${signature.toString("base64url")}`;
  }

  private json(res: ServerResponse, value: unknown): void {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(value));
  }

  private text(res: ServerResponse, status: number, value: string): void {
    res.statusCode = status;
    res.setHeader("content-type", "text/plain");
    res.end(value);
  }
}

test.describe("OIDC SSO", () => {
  test("OIDC link confirmation only mutates state on signed POST", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const me = (await (await owner.ctx.get("/api/v1/me")).json()) as {
      data: { principal: { userId: string } };
    };
    const token = createOidcLinkToken({
      userId: me.data.principal.userId,
      email: `${owner.username}@e2e.test`,
      orgSlug: owner.orgSlug,
      returnTo: "/api/v1/me",
    });

    const anon = await anonContext(baseURL!);
    const page = await anon.get(`/api/auth/oidc/link/confirm?token=${encodeURIComponent(token)}`);
    expect(page.status()).toBe(200);
    const html = await page.text();
    expect(html).toContain('method="post"');

    const unauthenticated = await anon.get("/api/v1/me");
    expect(unauthenticated.status()).toBe(401);

    const csrf = csrfFromConfirmationPage(html);
    const posted = await anon.post("/api/auth/oidc/link/confirm", {
      form: { token, csrf },
      maxRedirects: 0,
    });
    expect(posted.status()).toBe(302);
    expect(posted.headers().location).toBe("/api/v1/me");

    const linked = await anon.get("/api/v1/me");
    expect(linked.status()).toBe(200);
    const linkedBody = (await linked.json()) as {
      data: { principal: { kind: string; userId: string } };
    };
    expect(linkedBody.data.principal).toMatchObject({
      kind: "user",
      userId: me.data.principal.userId,
    });
  });

  test("signs in through OIDC and grants mapped org access", async ({ baseURL, page }) => {
    const provider = new FakeOidcProvider();
    await provider.start();
    try {
      const owner = await setupOwner(baseURL!);
      const org = await owner.ctx.post("/api/orgs", {
        data: { slug: ORG_SLUG, displayName: "OIDC E2E" },
      });
      expect([201, 409]).toContain(org.status());
      seedOidcManagedGroupPermissions();

      await page.goto(`${WEB}/login`);
      await page.getByRole("button", { name: "E2E SSO" }).click();
      await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
      await expect(page.getByTestId("org-switcher")).toContainText("OIDC E2E (2)");
    } finally {
      await provider.stop();
    }
  });
});
