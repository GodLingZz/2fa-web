import { test, expect } from "@playwright/test";

test("immediately shows the first code, refreshes once, then expires", async ({ page }) => {
  let verifyRequests = 0;

  await page.route("**/api/token/verify", async (route) => {
    const payload = JSON.parse(route.request().postData() || "{}");

    if (payload.mode === "check") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          accountId: "playwright-user",
          accountPassword: "playwright-password",
          status: "active"
        })
      });
      return;
    }

    verifyRequests += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        code: "111111",
        accountId: "playwright-user",
        timeLeft: 1,
        expiresAt: Date.now() + 1_000,
        nextCode: "222222",
        nextExpiresAt: Date.now() + 2_500
      })
    });
  });

  const port = process.env.PORT || 8789;
  await page.goto(`http://127.0.0.1:${port}/2fa-verify`);
  await expect(page.locator("#token")).toHaveAttribute("placeholder", "输入Token：TK-XXXX");
  await page.locator("#token").fill("TK-PLAY-TEST-0001");
  await page.locator("#submit-btn").click();
  await expect(page.locator("#step-guide")).toBeVisible();
  await page.locator("#use-token-btn").click();
  await page.locator("#confirm-ok-btn").click();

  await expect(page.locator("#code-zone")).toBeVisible();
  await expect(page.locator('[id="2fa-code"]')).toHaveText("111 111");
  await expect(page.locator("#waiting-zone")).toBeHidden();

  await expect.poll(() => page.locator('[id="2fa-code"]').innerText(), { timeout: 3_000 }).toBe("222 222");
  await expect(page.locator('[id="2fa-code"]')).toHaveText("222 222");
  await expect(page.locator("#time-left")).not.toHaveText("0s");

  await page.waitForTimeout(1_800);
  await expect(page.locator('[id="2fa-code"]')).toHaveText("--- ---");
  await expect(page.locator("#status-badge")).toContainText("口令已失效");
  await expect(page.locator("#time-left")).toHaveText("0s");
  expect(verifyRequests).toBe(1);
});
