import { describe, expect, test } from "bun:test";
import { db } from "@hootifactory/db";
import { FakeDb, withFakeDb } from "./fake-db";
import {
  OidcEmailLinkRequiredError,
  oidcIdentityBelongsToAnotherUser,
  syncOidcUser,
} from "./oidc-sync";
import type { SyncOidcUserInput } from "./oidc-types";

function baseInput(overrides: Partial<SyncOidcUserInput> = {}): SyncOidcUserInput {
  return {
    issuer: "https://idp.test",
    subject: "subject-1",
    email: "alice@oidc.test",
    emailVerified: true,
    username: "Alice SSO",
    displayName: "Alice SSO",
    groups: ["developers"],
    grants: [{ org: "acme", role: "developer", groups: ["developers"] }],
    ...overrides,
  };
}

describe("oidcIdentityBelongsToAnotherUser", () => {
  test("is false when no identity exists or it belongs to the same user", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([]);
      expect(
        await oidcIdentityBelongsToAnotherUser({
          issuer: "https://idp.test",
          subject: "s",
          userId: "u1",
        }),
      ).toBe(false);
      fake.queue([{ userId: "u1" }]);
      expect(
        await oidcIdentityBelongsToAnotherUser({
          issuer: "https://idp.test",
          subject: "s",
          userId: "u1",
        }),
      ).toBe(false);
    });
  });

  test("is true when the identity is owned by a different user", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ userId: "other" }]);
      expect(
        await oidcIdentityBelongsToAnotherUser({
          issuer: "https://idp.test",
          subject: "s",
          userId: "u1",
        }),
      ).toBe(true);
    });
  });
});

describe("syncOidcUser validation", () => {
  test("throws when no groups are mapped", async () => {
    await withFakeDb(db, async () => {
      await expect(syncOidcUser(baseInput({ grants: [] }))).rejects.toThrow("no mapped groups");
    });
  });

  test("throws when none of the mapped orgs exist", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([]); // org lookup returns nothing
      await expect(syncOidcUser(baseInput())).rejects.toThrow("no mapped organizations exist");
    });
  });
});

describe("syncOidcUser provisioning", () => {
  test("auto-provisions a new user, links the identity, and replaces role grants", async () => {
    const fake = new FakeDb();
    const restore = fake.install(db);
    try {
      fake.queue([{ id: "org-1", slug: "acme" }]); // org lookup
      // transaction:
      fake.queue([]); // linked external identity -> none
      fake.queue([]); // existing user by email -> none
      fake.queue([]); // uniqueUsername lookup -> available
      fake.queue([{ id: "user-1", username: "alice-sso", displayName: null }]); // insert user
      fake.queue([]); // insert externalIdentities (onConflictDoUpdate)
      fake.queue([]); // delete externalRoleGrants
      fake.queue([]); // insert externalRoleGrants
      const result = await syncOidcUser(baseInput());
      expect(result).toEqual({ id: "user-1", username: "alice-sso" });

      // The created user row carries the normalized username and external idp marker.
      const userInsert = fake.queries.find(
        (q) => q.kind === "insert" && (q.values as { username?: string }).username,
      );
      const values = userInsert!.values as Record<string, unknown>;
      expect(values.passwordHash).toBeNull();
      expect(values.externalIdp).toEqual({ issuer: "https://idp.test", subject: "subject-1" });

      // The role grant insert receives one mapped grant for the resolved org id.
      const grantInsert = fake.queries.at(-1)!;
      expect(grantInsert.kind).toBe("insert");
      expect(grantInsert.values).toEqual([
        {
          provider: "oidc",
          issuer: "https://idp.test",
          userId: "user-1",
          orgId: "org-1",
          role: "developer",
          groups: ["developers"],
        },
      ]);
    } finally {
      restore();
    }
  });

  test("normalizes a non-unique username by appending a numeric suffix", async () => {
    const fake = new FakeDb();
    const restore = fake.install(db);
    try {
      fake.queue([{ id: "org-1", slug: "acme" }]); // org lookup
      fake.queue([]); // linked identity -> none
      fake.queue([]); // existing by email -> none
      fake.queue([{ id: "taken" }]); // uniqueUsername attempt 0 -> taken
      fake.queue([]); // uniqueUsername attempt 1 -> free
      fake.queue([{ id: "user-2", username: "alice-sso-1", displayName: null }]); // insert user
      fake.queue([]); // identity upsert
      fake.queue([]); // delete grants
      fake.queue([]); // insert grants
      const result = await syncOidcUser(baseInput());
      expect(result.username).toBe("alice-sso-1");
    } finally {
      restore();
    }
  });

  test("requires confirmation before linking an existing local email", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "org-1", slug: "acme" }]); // org lookup
      fake.queue([]); // linked identity -> none
      fake.queue([{ id: "local-1", email: "alice@oidc.test", isActive: true }]); // existing by email
      await expect(syncOidcUser(baseInput())).rejects.toBeInstanceOf(OidcEmailLinkRequiredError);
    });
  });

  test("links an existing local email when explicitly allowed and updates the user", async () => {
    const fake = new FakeDb();
    const restore = fake.install(db);
    try {
      fake.queue([{ id: "org-1", slug: "acme" }]); // org lookup
      fake.queue([]); // linked identity -> none
      fake.queue([
        {
          id: "local-1",
          email: "alice@oidc.test",
          isActive: true,
          username: "alice",
          displayName: "Alice",
        },
      ]); // existing by email
      fake.queue([]); // update users (existing-user branch)
      fake.queue([]); // identity upsert
      fake.queue([]); // delete grants
      fake.queue([]); // insert grants
      const result = await syncOidcUser(baseInput(), { allowExistingEmailLink: true });
      expect(result).toEqual({ id: "local-1", username: "alice" });
      // The existing-user branch issues an update, never a user insert.
      expect(fake.queries.some((q) => q.kind === "update")).toBe(true);
    } finally {
      restore();
    }
  });

  test("rejects linking when the IdP email is unverified", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "org-1", slug: "acme" }]); // org lookup
      fake.queue([]); // linked identity -> none
      fake.queue([{ id: "local-1", email: "alice@oidc.test", isActive: true }]); // existing by email
      await expect(
        syncOidcUser(baseInput({ emailVerified: false }), { allowExistingEmailLink: true }),
      ).rejects.toThrow("email claim is not verified");
    });
  });

  test("rejects a disabled linked user", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "org-1", slug: "acme" }]); // org lookup
      fake.queue([{ user: { id: "user-1", isActive: false } }]); // linked identity -> disabled
      await expect(syncOidcUser(baseInput())).rejects.toThrow("linked user is disabled");
    });
  });

  test("rejects a disabled existing email account", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "org-1", slug: "acme" }]); // org lookup
      fake.queue([]); // linked identity -> none
      fake.queue([{ id: "local-1", email: "alice@oidc.test", isActive: false }]); // existing by email
      await expect(syncOidcUser(baseInput())).rejects.toThrow("existing user is disabled");
    });
  });

  test("requires an email to create a brand-new user", async () => {
    await withFakeDb(db, async (fake) => {
      fake.queue([{ id: "org-1", slug: "acme" }]); // org lookup
      fake.queue([]); // linked identity -> none
      // No email -> skip the email lookup, then fail at user creation.
      await expect(syncOidcUser(baseInput({ email: null }))).rejects.toThrow(
        "email claim is required",
      );
    });
  });
});
