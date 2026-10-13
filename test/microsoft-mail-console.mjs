import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-microsoft-console-"));
const socket = net.createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const base = `http://127.0.0.1:${port}`;
const output = path.join(temporary, "jobs");
const env = { ...process.env, ONBOARDING_OUTPUT_ROOT: output,
  ONBOARDING_PROTOCOL_SCRIPT: path.join(root, "test", "mock-queue-protocol.mjs"),
  TOSUB2_WINDOWS_CREDENTIAL_ROOT: path.join(temporary, "credentials"),
  TOSUB2_MAC_CREDENTIAL_ROOT: path.join(temporary, "credentials"), TOSUB2_TLS_PROFILE: "chrome142" };
let child;
function launch() {
  child = spawn(process.execPath, [path.join(root, "src", "console-server.mjs"), "--host", "127.0.0.1", "--port", String(port)],
    { cwd: root, env, stdio: "ignore", windowsHide: true });
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function bootstrap() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { const response = await fetch(`${base}/api/bootstrap`); if (response.ok) return response.json(); } catch {}
    await wait(100);
  }
  throw new Error("console startup timeout");
}
async function stop() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
}
try {
  launch();
  let headers = { "content-type": "application/json", "x-console-token": (await bootstrap()).token };
  // Fill all slots with local fake protocol jobs: the mailbox import stays queued and never hits Microsoft.
  let response = await fetch(`${base}/api/jobs/batch`, { method: "POST", headers,
    body: JSON.stringify({ text: Array.from({ length: 20 }, (_, i) => `block-${i}@example.com`).join("\n") }) });
  assert.equal(response.status, 201);
  const clientId = "00000000-0000-0000-0000-000000000001";
  const refreshToken = "synthetic-console-refresh-token";
  response = await fetch(`${base}/api/jobs/batch`, { method: "POST", headers,
    body: JSON.stringify({ text: `test@outlook.com----mailbox-password-not-chatgpt----${clientId}----${refreshToken}` }) });
  assert.equal(response.status, 201);
  const page = await fetch(`${base}/api/jobs`, { headers }).then((res) => res.json());
  const job = page.jobs.find((item) => item.email === "test@outlook.com");
  assert.ok(job);
  assert.equal(job.status, "queued");
  assert.equal(job.loginMode, "email_otp");
  assert.equal(job.mailProvider, "microsoft");
  assert.equal(job.autoEmailOtp, true);
  assert.equal(JSON.stringify(page).includes(refreshToken), false);
  const metadataPath = path.join(output, job.id, "job-meta.json");
  const metadata = await fs.readFile(metadataPath, "utf8");
  assert.equal(JSON.parse(metadata).has_microsoft_mailbox, true);
  assert.equal(metadata.includes(refreshToken), false);
  assert.equal(metadata.includes("mailbox-password-not-chatgpt"), false);
  response = await fetch(`${base}/api/jobs/export-source`, { method: "POST", headers, body: JSON.stringify({ ids: [job.id] }) });
  assert.equal(response.status, 409);
  response = await fetch(`${base}/api/jobs/${job.id}/cancel`, { method: "POST", headers, body: "{}" });
  assert.equal(response.status, 200);
  for (let attempt = 0; attempt < 30; attempt++) {
    if (JSON.parse(await fs.readFile(metadataPath, "utf8")).status === "canceled") break;
    await wait(100);
  }
  assert.equal(JSON.parse(await fs.readFile(metadataPath, "utf8")).status, "canceled");
  await stop();
  launch();
  headers = { ...headers, "x-console-token": (await bootstrap()).token };
  const restoredPage = await fetch(`${base}/api/jobs`, { headers }).then((res) => res.json());
  const restored = restoredPage.jobs.find((item) => item.id === job.id);
  assert.equal(restored.status, "canceled");
  assert.equal(restored.mailProvider, "microsoft");
  assert.equal(restored.autoEmailOtp, process.platform === "win32" || process.platform === "darwin");
  console.log("Microsoft mailbox import, encrypted persistence, redaction and restart tests passed");
} finally {
  await stop();
  await fs.rm(temporary, { recursive: true, force: true });
}
