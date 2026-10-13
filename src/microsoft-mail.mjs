import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { extractMailboxOtpCandidates } from "./mail-otp.mjs";

const CLIENT_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const sessions = new WeakMap();
const workerPath = fileURLToPath(new URL("./microsoft-mail-worker.py", import.meta.url));

export function normalizeMicrosoftMailbox(value) {
  if (value == null) return null;
  const clientId = String(value.clientId || "").trim();
  const refreshToken = String(value.refreshToken || "").trim();
  if (!CLIENT_ID.test(clientId) || !refreshToken || refreshToken.length > 16_384 || /[\s\x00-\x1f]/.test(refreshToken)) {
    const error = new Error("微软邮箱需要有效的 Client ID 和非空 Refresh Token，请检查四段格式");
    error.status = 400;
    throw error;
  }
  return { clientId, refreshToken };
}

export function parseMicrosoftAccountLine(line) {
  const fields = String(line).split("----").map((value) => value.trim());
  if (!/@(?:hotmail|outlook|live|msn)\.(?:com|cn|co\.uk|jp|de|fr|it|es|com\.au)$/i.test(fields[0])) return null;
  if (fields.length < 4 || /^https?:\/\//i.test(fields[2])) return null;
  if (![4, 5].includes(fields.length)) throw new Error("微软邮箱请使用 邮箱----邮箱密码----Client ID----Refresh Token，可追加登录 2FA 密钥");
  return {
    email: fields[0],
    password: "", // Mailbox passwords must never be used as ChatGPT passwords.
    loginMode: "email_otp",
    microsoftMailbox: normalizeMicrosoftMailbox({ clientId: fields[2], refreshToken: fields[3] }),
    totpSecret: fields[4] || "",
  };
}

export async function fetchMicrosoftMailboxOtpCandidates(email, mailbox, options = {}) {
  normalizeMicrosoftMailbox(mailbox);
  const signal = options.signal;
  signal?.throwIfAborted();
  let session = sessions.get(mailbox);
  if (!session || session.expiresAt <= Date.now()) {
    const body = new URLSearchParams({
      client_id: mailbox.clientId,
      refresh_token: mailbox.refreshToken,
      grant_type: "refresh_token",
      scope: "https://outlook.office.com/IMAP.AccessAsUser.All offline_access",
    });
    let response;
    try {
      response = await (options.fetchImpl || fetch)("https://login.microsoftonline.com/consumers/oauth2/v2.0/token", {
        method: "POST", body, redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
      });
    } catch {
      signal?.throwIfAborted();
      throw new Error("微软邮箱令牌服务连接失败或超时，请检查本机网络");
    }
    let token;
    try { token = await response.json(); } catch { throw new Error("微软邮箱令牌服务返回无效响应"); }
    if (!response.ok || typeof token.access_token !== "string" || !token.access_token) {
      const code = /^[a-z_]{1,50}$/.test(token.error || "") ? token.error : `HTTP ${response.status}`;
      const error = new Error(`微软邮箱授权失败（${code}），请确认令牌有效且应用已获得 IMAP 权限；仍可手动输入验证码`);
      error.retryable = response.status >= 500 || response.status === 429;
      throw error;
    }
    if (typeof token.refresh_token === "string" && token.refresh_token && token.refresh_token !== mailbox.refreshToken) {
      const updated = normalizeMicrosoftMailbox({ ...mailbox, refreshToken: token.refresh_token });
      // Save rotated refresh tokens before reading mail, so a later IMAP failure cannot lose them.
      await options.onRefreshToken?.(updated);
      Object.assign(mailbox, updated);
    }
    session = { accessToken: token.access_token, expiresAt: Date.now() + Math.max(1, Number(token.expires_in) || 3600) * 1000 - 60_000 };
    sessions.set(mailbox, session);
  }
  signal?.throwIfAborted();
  try {
    const messages = await (options.readImap || readMicrosoftImap)(email, session.accessToken, { signal });
    return extractMailboxOtpCandidates(JSON.stringify(messages));
  } catch (error) {
    if (error.retryable === false || error.code === "MICROSOFT_IMAP_ERROR") sessions.delete(mailbox);
    throw error;
  }
}

function readMicrosoftImap(email, accessToken, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const python = process.env.TOSUB2_PYTHON || (process.platform === "win32" ? "python" : "python3");
    const child = spawn(python, [workerPath], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("微软邮箱读取超时，请检查 IMAP 连接"));
    }, 45_000);
    const abort = () => { child.kill(); reject(signal.reason || new Error("邮箱读取已取消")); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 2 * 1024 * 1024) { child.kill(); reject(new Error("微软邮箱响应超过大小限制")); }
    });
    child.stdin.on("error", () => {});
    child.once("error", () => reject(new Error("无法启动微软邮箱读取进程，请检查项目 Python 环境")));
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      try {
        const result = JSON.parse(output);
        if (code !== 0 || result.error) {
          const error = new Error(result.error || "微软邮箱读取失败");
          error.retryable = result.retryable !== false;
          if (result.code === "MICROSOFT_IMAP_ERROR") error.code = result.code;
          reject(error);
        } else if (Array.isArray(result.messages)) resolve(result.messages);
        else reject(new Error("微软邮箱读取响应格式错误"));
      } catch { reject(new Error("微软邮箱读取失败或响应格式错误")); }
    });
    child.stdin.end(JSON.stringify({ email, accessToken }));
  });
}
