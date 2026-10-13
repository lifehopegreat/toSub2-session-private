import assert from "node:assert/strict";
import { createCredentialStore } from "../src/credential-store.mjs";
import { fetchMicrosoftMailboxOtpCandidates } from "../src/microsoft-mail.mjs";

// Only read recent OpenAI mail for one existing local job; never print credentials, mail bodies or OTPs.
const base = process.env.TOSUB2_LIVE_URL || "http://127.0.0.1:4399";
assert.equal(new URL(base).hostname, "127.0.0.1");
const bootstrap = await fetch(`${base}/api/bootstrap`).then((response) => response.json());
const firstPage = await fetch(`${base}/api/jobs`, { headers: { "x-console-token": bootstrap.token } }).then((response) => response.json());
const jobs = [...firstPage.jobs];
for (let page = 2; page <= firstPage.pagination.totalPages; page++) {
  const next = await fetch(`${base}/api/jobs?page=${page}`, { headers: { "x-console-token": bootstrap.token } }).then((response) => response.json());
  jobs.push(...next.jobs);
}
const job = jobs.find((item) => item.id === process.env.TOSUB2_LIVE_JOB_ID);
assert.ok(job?.mailProvider === "microsoft", "Specify an existing Microsoft-mailbox job with TOSUB2_LIVE_JOB_ID");
const store = createCredentialStore();
const credentials = await store.load(job.email);
assert.ok(credentials.microsoftMailbox, "The encrypted mailbox authorization must be available");
for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    const candidates = await fetchMicrosoftMailboxOtpCandidates(job.email, credentials.microsoftMailbox, {
      onRefreshToken: async (mailbox) => store.save(job.email, { ...await store.load(job.email), microsoftMailbox: mailbox }),
    });
    console.log(JSON.stringify({ actualMailboxRead: true, readAttempts: attempt, otpCandidates: candidates.length }));
    break;
  } catch (error) {
    console.log(JSON.stringify({ actualMailboxRead: false, readAttempts: attempt, error: error.message }));
    if (error.retryable === false || attempt === 3) { process.exitCode = 1; break; }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}
