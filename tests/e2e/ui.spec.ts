import { expect, test } from "@playwright/test";

const WEB = `http://127.0.0.1:${process.env.E2E_WEB_PORT ?? 5174}`;

test.describe("web UI (browser)", () => {
  test("register -> create org -> create repo -> view detail snippets", async ({ page }) => {
    const id = Date.now().toString(36);
    const username = `uiuser${id}`;

    await page.goto(`${WEB}/login`);

    // switch to register and sign up
    await page.getByRole("button", { name: "Need an account? Register" }).click();
    await page.locator('input[autocomplete="username"]').fill(username);
    await page.locator('input[type="email"]').fill(`${username}@e2e.test`);
    await page.locator('input[type="password"]').fill("password1234");
    await page.getByRole("button", { name: "Register", exact: true }).click();

    // onboarding: create the first org
    await page.getByTestId("org-slug").fill(`uiorg-${id}`);
    await page.getByTestId("org-create").click();

    // dashboard renders
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

    // create a repository
    await page.getByRole("link", { name: "Repositories" }).click();
    await page.getByTestId("new-repo").click();
    await page.getByTestId("repo-name").fill("uirepo");
    await page.getByTestId("repo-format").selectOption("docker");
    await page.getByTestId("repo-create").click();

    // it appears in the table
    await expect(page.getByRole("link", { name: "uirepo" })).toBeVisible();

    // open detail and see usage snippets
    await page.getByRole("link", { name: "uirepo" }).click();
    await expect(page.getByText("How to use")).toBeVisible();
    await expect(page.getByText("docker pull", { exact: false })).toBeVisible();

    // create an API token
    await page.getByRole("link", { name: "API Tokens" }).click();
    await page.getByTestId("token-name").fill("ci");
    await page.getByTestId("token-create").click();
    await expect(page.getByTestId("token-secret")).toContainText(/hoot_/);
  });
});
