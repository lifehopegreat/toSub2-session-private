import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createCredentialStore } from "../src/credential-store.mjs";

// Read-only proof for specified real tasks: never invent account/session responses or trigger registration.
const ids = String(process.env.TOSUB2_LIVE_REGISTRATION_IDS || "").split(",").filter(Boolean);
assert.ok(ids.length > 0 && ids.every((id) => /^[a-f0-9-]{36}$/.test(id)), "Specify actual task IDs with TOSUB2_LIVE_REGISTRATION_IDS");
const base = "http://127.0.0.1:4399";
const boot = await fetch(`${base}/api/bootstrap`).then((response) => response.json());
const headers = { "x-console-token": boot.token };
const first = await fetch(`${base}/api/jobs`, { headers }).then((response) => response.json());
const jobs = [...first.jobs];
for (let page = 2; page <= first.pagination.totalPages; page++) jobs.push(...(await fetch(`${base}/api/jobs?page=${page}`, { headers }).then((response) => response.json())).jobs);
const store = createCredentialStore();
let confirmed = 0;
for (const id of ids) {
  const job = jobs.find((item) => item.id === id);
  assert.ok(job, "The specified task must exist");
  const credentials = await store.load(job.email);
  if (!job.canCopySession || !job.registrationConfirmed) {
    console.log(JSON.stringify({ id, status: job.status, registrationConfirmed: false, needsCheck: job.needsCheck,
      profileEncrypted: Boolean(credentials.registrationProfile), registrationPending: credentials.securityPending?.operation === "account_create" }));
    process.exitCode = 1;
    continue;
  }
  const response = await fetch(`${base}/api/jobs/${id}/session`, { headers });
  assert.equal(response.status, 200);
  const session = await response.json();
  assert.ok(session.accessToken && Date.parse(session.expires) > Date.now());
  assert.ok(String(session.user?.email || "").toLowerCase() === job.email.toLowerCase(), "Remote identity must match the task");
  assert.ok(credentials.registrationProfile?.name && /^\d{4}-\d{2}-\d{2}$/.test(credentials.registrationProfile?.birthdate), "The approved test profile must be encrypted locally");
  assert.ok(credentials.registrationCompletedAt && !credentials.securityPending, "Registration must be confirmed, not merely submitted");
  assert.ok(!credentials.password && !credentials.totpSecret, "This task must not change password or MFA");
  const { logs } = await fetch(`${base}/api/jobs/${id}/logs`, { headers }).then((response) => response.json());
  if (logs.includes("[registration-created]")) {
    assert.equal((logs.match(/^< POST https:\/\/auth\.openai\.com\/api\/accounts\/create_account \d+/gm) || []).length, 1,
      "A confirmed creation must not be replayed");
  }
  confirmed++;
  console.log(JSON.stringify({ id, actualRegistrationConfirmed: true, identityMatched: true, profileEncrypted: true,
    passwordAndMfaUnchanged: true, sessionSha256: crypto.createHash("sha256").update(JSON.stringify(session)).digest("hex") }));
}
console.log(JSON.stringify({ specifiedTasks: ids.length, actualRegistrationsConfirmed: confirmed }));
