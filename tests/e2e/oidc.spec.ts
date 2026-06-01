import { createSign, generateKeyPairSync } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { expect, test } from "@playwright/test";
import { setupOwner } from "./helpers";

const WEB = `http://127.0.0.1:${process.env.E2E_WEB_PORT ?? 5174}`;
const OIDC_PORT = Number(process.env.E2E_OIDC_PORT ?? 4578);
const ISSUER = `http://127.0.0.1:${OIDC_PORT}`;
const CLIENT_ID = "hootifactory-e2e";
const CLIENT_SECRET = "e2e-secret";
const ORG_SLUG = "oidc-e2e";

function b64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
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
  test("signs in through OIDC and grants mapped org access", async ({ baseURL, page }) => {
    const provider = new FakeOidcProvider();
    await provider.start();
    try {
      const owner = await setupOwner(baseURL!);
      const org = await owner.ctx.post("/api/orgs", {
        data: { slug: ORG_SLUG, displayName: "OIDC E2E" },
      });
      expect([201, 409]).toContain(org.status());

      await page.goto(`${WEB}/login`);
      await page.getByRole("button", { name: "E2E SSO" }).click();
      await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
      await expect(page.getByTestId("org-switcher")).toContainText("OIDC E2E (owner)");
    } finally {
      await provider.stop();
    }
  });
});
