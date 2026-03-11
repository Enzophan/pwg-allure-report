import { expect, Locator, Page } from "@playwright/test";

//https://playwright.dev/docs/pom

export class LoginPage {
  readonly page: Page;
  readonly loginBtn: Locator;
  readonly usernameTextbox: Locator;
  readonly nextBtn: Locator;

  constructor(page) {
    this.page = page;
    this.loginBtn = this.page.getByRole("link", { name: "Đăng nhập" });
    this.usernameTextbox = this.page.getByRole("textbox", {
      name: "Email hoặc số điện thoại",
    });
    this.nextBtn = this.page.getByRole("button", { name: "Tiếp theo" });
  }

  async clickLogin() {
    await this.loginBtn.click();
  }

  async enterUsername(username) {
    await this.usernameTextbox.click();
    await this.usernameTextbox.fill(username);
  }

  async clickNextBtn() {
    await this.nextBtn.click();
  }
}
