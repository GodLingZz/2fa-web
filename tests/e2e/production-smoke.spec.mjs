import { test, expect } from "@playwright/test";

test("production page serves the immediate-display UI", async ({ page }) => {
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  const response = await page.goto("https://2fa-verify.pages.dev/2fa-verify");
  expect(response?.status()).toBe(200);
  await expect(page.locator('[id="token"]')).toHaveAttribute("placeholder", "输入Token：TK-XXXX");
  await expect(page.locator("body")).not.toContainText("距离发放新口令还有");
  expect(consoleErrors).toEqual([]);
});
