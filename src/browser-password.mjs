import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

// Use the real installed browser for the normal password reauthentication form; never solve challenges.
export async function addPasswordInBrowser({ client, chatgptBase, authBase, email, password, readCode, beforeSubmit }) {
  const modulePath = process.env.TOSUB2_PLAYWRIGHT_MODULE;
  const { chromium } = await import(modulePath ? pathToFileURL(modulePath).href : "playwright");
  const browser = await chromium.launch({ headless: false,
    executablePath: path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") });
  const context = await browser.newContext({ locale: "zh-CN" });
  const page = await context.newPage();
  let phase = "browser_start";
  const syncCookies = async () => client.jar.merge((await context.cookies()).map((cookie) => ({
    ...cookie, expires: cookie.expires > 0 ? cookie.expires * 1000 : null,
  })));
  const browserClient = {
    jar: client.jar, transport: client.transport, nativePasswordCallbackHandled: true,
    close: () => browser.close(),
    async follow(url) {
      const target = new URL(url);
      if (![new URL(chatgptBase).hostname, new URL(authBase).hostname].includes(target.hostname)) throw new Error("浏览器登录目标不在当前账号服务范围内");
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      if (response?.status() >= 400) throw new Error(`正常浏览器访问失败：HTTP ${response.status()}，需要检查`);
      await syncCookies();
      return { finalUrl: page.url(), last: { text: await page.content() } };
    },
    async getJson(method, url, options = {}) {
      const target = new URL(url);
      if (![new URL(chatgptBase).hostname, new URL(authBase).hostname].includes(target.hostname)) throw new Error("浏览器请求目标不在当前账号服务范围内");
      if (new URL(page.url()).origin !== target.origin) await this.follow(`${target.origin}/`);
      const result = await page.evaluate(async ({ method, url, headers, json }) => {
        const response = await fetch(url, { method, credentials: "include", headers: { ...headers, ...(json ? { "content-type": "application/json" } : {}) },
          ...(json ? { body: JSON.stringify(json) } : {}), signal: AbortSignal.timeout(30_000) });
        let data;
        try { data = await response.json(); } catch { data = null; }
        return { status: response.status, ok: response.ok, data };
      }, { method, url, headers: options.headers || {}, json: options.json || null });
      await syncCookies();
      console.error(`< BROWSER ${method} ${target.origin}${target.pathname} ${result.status}`);
      if (!result.ok || result.data == null) throw new Error(`浏览器接口 ${target.pathname} 返回 HTTP ${result.status}，需要检查`);
      return { data: result.data, result: { res: { status: result.status, ok: result.ok } } };
    },
  };
  try {
    await context.addCookies(client.jar.toJSON().filter((cookie) => !cookie.expires || cookie.expires > Date.now()).map((cookie) => ({
      name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
      httpOnly: Boolean(cookie.httpOnly), secure: Boolean(cookie.secure), expires: cookie.expires ? cookie.expires / 1000 : -1,
    })));
    phase = "session_identity";
    await browserClient.follow(`${chatgptBase}/`);
    const { data: session } = await browserClient.getJson("GET", `${chatgptBase}/api/auth/session`);
    if (String(session.user?.email || "").toLowerCase() !== email.toLowerCase() || !session.accessToken) throw new Error("浏览器远端账号身份不一致");
    const requestedAt = Date.now();
    phase = "password_reauthentication";
    const signin = await page.evaluate(async ({ email, deviceId }) => {
      const csrf = await fetch("/api/auth/csrf").then((response) => response.json());
      const params = new URLSearchParams({ connection: "password", login_hint: email, reauth: "password", post_login_add_password: "true", max_age: "0", "ext-oai-did": deviceId });
      const response = await fetch(`/api/auth/signin/openai?${params}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ callbackUrl: location.origin + "/", csrfToken: csrf.csrfToken, json: "true" }) });
      return response.json();
    }, { email, deviceId: client.jar.value("oai-did", `${chatgptBase}/`) || crypto.randomUUID() });
    if (!signin.url || new URL(signin.url).hostname !== new URL(authBase).hostname) throw new Error("浏览器身份验证回调地址不正确");
    await browserClient.follow(signin.url);
    if (new URL(page.url()).pathname === "/email-verification") {
      phase = "email_verification";
      console.log("[combine-browser] 正常浏览器要求邮箱验证，正在读取真实新邮件。");
      const code = await readCode(requestedAt);
      await page.getByRole("textbox").fill(code);
      await page.getByRole("button", { name: /^(继续|Continue|验证|Verify)$/i }).click();
      await page.waitForURL("**/reset-password/new-password", { timeout: 60_000 });
    }
    if (new URL(page.url()).pathname !== "/reset-password/new-password") throw new Error("浏览器仍需要人工账号验证，不能自动提交密码");
    phase = "password_form";
    await page.locator('input[type="password"]').first().waitFor({ state: "visible", timeout: 30_000 });
    const inputs = page.locator('input[type="password"]');
    for (let index = 0; index < await inputs.count(); index++) await inputs.nth(index).fill(password);
    const submit = page.getByRole("button", { name: /^(继续|Continue|设置密码|Set password|保存|Save)$/i });
    await submit.waitFor({ state: "visible", timeout: 30_000 });
    await beforeSubmit();
    phase = "password_submit";
    const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/accounts/password/add" && response.request().method() === "POST", { timeout: 45_000 });
    void responsePromise.catch(() => {});
    await submit.click();
    const response = await responsePromise;
    if (!response.ok()) throw new Error(`密码提交接口返回 HTTP ${response.status()}，需要检查`);
    const data = await response.json();
    phase = "password_callback";
    await page.waitForURL((url) => url.hostname === new URL(chatgptBase).hostname, { timeout: 45_000 });
    await syncCookies();
    console.log("[combine-browser-password-confirmed] 正常浏览器密码接口已返回成功。");
    return { client: browserClient, data };
  } catch {
    await browser.close();
    // Playwright errors can include filled passwords/codes, so never propagate their text.
    throw new Error(`BROWSER_PASSWORD_FLOW_INCOMPLETE: 正常浏览器在 ${phase} 阶段未完成，需要检查；未绕过验证`);
  }
}
