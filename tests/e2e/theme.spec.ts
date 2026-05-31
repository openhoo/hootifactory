import { expect, test } from "@playwright/test";

const WEB = `http://127.0.0.1:${process.env.E2E_WEB_PORT ?? 5174}`;

// styles.css: light body = #fafaf9, dark body = #0c0a09.
const LIGHT_BG = "rgb(250, 250, 249)";
const DARK_BG = "rgb(12, 10, 9)";

// Pin the simulated OS preference so "system" is deterministic.
test.use({ colorScheme: "light" });

test.describe("theme toggle", () => {
  test("switches light/dark/system and persists across reload", async ({ page }) => {
    await page.goto(`${WEB}/login`);
    const html = page.locator("html");
    const body = page.locator("body");

    // Default is "system"; with OS = light the page is not dark.
    await expect(html).not.toHaveClass(/dark/);
    await expect(body).toHaveCSS("background-color", LIGHT_BG);

    // Choose dark: class flips, the actual background applies, state persists.
    await page.getByTestId("theme-dark").click();
    await expect(html).toHaveClass(/dark/);
    await expect(body).toHaveCSS("background-color", DARK_BG);
    await expect(page.getByTestId("theme-dark")).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate(() => localStorage.getItem("hoot_theme"))).toBe("dark");

    // Survives a reload with the dark background already applied (inline head
    // script sets .dark before paint, so there is no flash of the light theme).
    await page.reload();
    await expect(html).toHaveClass(/dark/);
    await expect(body).toHaveCSS("background-color", DARK_BG);

    // Choose light.
    await page.getByTestId("theme-light").click();
    await expect(html).not.toHaveClass(/dark/);
    await expect(body).toHaveCSS("background-color", LIGHT_BG);
    expect(await page.evaluate(() => localStorage.getItem("hoot_theme"))).toBe("light");

    // Choose system: OS = light, so not dark, and the stored override is cleared.
    await page.getByTestId("theme-system").click();
    await expect(html).not.toHaveClass(/dark/);
    expect(await page.evaluate(() => localStorage.getItem("hoot_theme"))).toBeNull();
  });
});
