import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fetchMicrosoftMailboxOtpCandidates, normalizeMicrosoftMailbox, parseMicrosoftAccountLine } from "../src/microsoft-mail.mjs";

const clientId = "00000000-0000-0000-0000-000000000001";
const original = { clientId, refreshToken: "synthetic-refresh-token" };
for (const domain of ["hotmail.com", "outlook.com"]) {
  const parsed = parseMicrosoftAccountLine(`test@${domain}----mailbox-password----${clientId}----synthetic-refresh-token`);
  assert.equal(parsed.password, "");
  assert.equal(parsed.loginMode, "email_otp");
  assert.deepEqual(parsed.microsoftMailbox, original);
}
assert.equal(parseMicrosoftAccountLine("test@outlook.com----password----https://mail.example/inbox----JBSWY3DPEHPK3PXP"), null);
assert.throws(() => normalizeMicrosoftMailbox({ clientId, refreshToken: "token\nheader" }));
assert.throws(() => parseMicrosoftAccountLine("test@outlook.com----password----bad-id----token"));
const mailbox = { ...original };
let refreshes = 0;
let saved = false;
const options = {
  fetchImpl: async (url, request) => {
    assert.equal(url, "https://login.microsoftonline.com/consumers/oauth2/v2.0/token");
    assert.equal(request.body.get("refresh_token"), original.refreshToken);
    assert.equal(request.body.has("password"), false);
    assert.match(request.body.get("scope"), /IMAP.AccessAsUser.All/);
    refreshes++;
    return new Response(JSON.stringify({ access_token: "synthetic-access", refresh_token: "rotated-synthetic-refresh", expires_in: 3600 }));
  },
  onRefreshToken: async (updated) => { assert.equal(updated.refreshToken, "rotated-synthetic-refresh"); saved = true; },
  readImap: async (address, accessToken) => {
    assert.ok(saved, "rotated token must be saved before IMAP access");
    assert.equal(address, "test@outlook.com");
    assert.equal(accessToken, "synthetic-access");
    return [{ id: "INBOX:123", received_at: Date.now(), subject: "OpenAI verification code", body: "Your security code is 123456" }];
  },
};
assert.equal((await fetchMicrosoftMailboxOtpCandidates("test@outlook.com", mailbox, options))[0].code, "123456");
assert.equal((await fetchMicrosoftMailboxOtpCandidates("test@outlook.com", mailbox, options))[0].code, "123456");
assert.equal(refreshes, 1, "access token should be cached");
assert.equal(mailbox.refreshToken, "rotated-synthetic-refresh");
await assert.rejects(fetchMicrosoftMailboxOtpCandidates("test@outlook.com", { ...original }, {
  fetchImpl: async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "secret-must-not-leak" }), { status: 400 }),
}), (error) => error.retryable === false && /invalid_grant/.test(error.message) && !error.message.includes("secret-must-not-leak"));
const canceled = new AbortController();
canceled.abort();
await assert.rejects(fetchMicrosoftMailboxOtpCandidates("test@outlook.com", { ...original }, { signal: canceled.signal }));

const python = process.env.TOSUB2_PYTHON || (process.platform === "win32" ? "python" : "python3");
const result = spawnSync(python, [fileURLToPath(new URL("./microsoft-mail-worker.py", import.meta.url))], { encoding: "utf8", windowsHide: true });
assert.equal(result.status, 0, result.stderr);
console.log("Microsoft mailbox parser, token rotation/cache and readonly IMAP tests passed");
