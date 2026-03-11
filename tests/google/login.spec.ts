import { test, expect } from "@playwright/test";
import { LoginPage } from "../../pages/login";
import * as allure from "allure-js-commons";

test("Verify require field", async ({ page }) => {
  await allure.severity("critical");
  const loginPage = new LoginPage(page);
  await page.goto("https://www.google.com/");
  await loginPage.clickLogin();
  await loginPage.enterUsername(" ");
  await loginPage.clickNextBtn();
  await page.getByText("Hãy nhập email hoặc số điện thoại").isVisible();
  await expect(page.locator("div.Ekjuhf.Jj6Lae")).toHaveText(
    /^Hãy nhập email hoặc số điện thoại$/
  );
});
