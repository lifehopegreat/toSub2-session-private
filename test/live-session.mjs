import assert from "node:assert/strict";
import crypto from "node:crypto";
import { sessionExpiryStatus } from "../src/session-status.mjs";

// Read-only acceptance check against an existing real local job; never creates accounts or modifies security settings.
const base = process.env.TOSUB2_LIVE_URL || "http://127.0.0.1:4399";
assert.equal(new URL(base).hostname, "127.0.0.1", "Only the local console may be checked");
const bootstrap = await fetch(`${base}/api/bootstrap`).then((response) => response.json());
const headers = { "x-console-token": bootstrap.token };
const firstPage = await fetch(`${base}/api/jobs`, { headers: headers }).then((response) => response.json());
const jobs = [...firstPage.jobs];
for (let page = 2; page <= firstPage.pagination.totalPages; page++) {
  const next = await fetch(`${base}/api/jobs?page=${page}`, { headers: headers }).then((response) => response.json());
  jobs.push(...next.jobs);
}
const job = process.env.TOSUB2_LIVE_JOB_ID
  ? jobs.find((item) => item.id === process.env.TOSUB2_LIVE_JOB_ID)
  : jobs.find((item) => item.canCopySession);
assert.ok(job?.canCopySession, "An existing real job with a saved session is required");
const url = `${base}/api/jobs/${job.id}/session`;
const unauthorized = await fetch(url);
assert.equal(unauthorized.status, 403, "Session export must require the console token");
const single = await fetch(url, { headers });
assert.equal(single.status, 200);
assert.equal(single.headers.get("cache-control"), "no-store");
const session = await single.json();
assert.equal(session.user?.email?.toLowerCase(), job.email.toLowerCase(), "Real identity must match the selected job");
assert.ok(typeof session.accessToken === "string" && session.accessToken.length > 0);
assert.ok(Date.parse(session.expires) > Date.now(), "Expired sessions must not be exported");
assert.equal(job.sessionExpiryStatus, "valid");
assert.equal(typeof job.proxyRotation, "boolean");
// Check expiry boundaries using the actual account's expires value, without altering any saved session.
assert.equal(sessionExpiryStatus(session.expires, Date.parse(session.expires) - 1), "valid");
assert.equal(sessionExpiryStatus(session.expires, Date.parse(session.expires)), "expired");
const batch = await fetch(`${base}/api/jobs/session-batch`, {
  method: "POST", headers: { ...headers, "content-type": "application/json" },
  body: JSON.stringify({ ids: [job.id] }),
});
assert.equal(batch.status, 200);
assert.equal(batch.headers.get("cache-control"), "no-store");
assert.match(batch.headers.get("content-disposition"), /^attachment; filename="chatgpt-sessions-1-/);
assert.ok(JSON.stringify(await batch.json()) === JSON.stringify([session]), "The actual batch export must match the session endpoint");
assert.equal(job.needsCheck, false, "Uncertain security changes must block export");
if (job.autoRepairBlocked) {
  assert.equal(job.canCombine, false, "An account reported deactivated must not modify security settings");
  assert.match(job.prompt, /删除或停用/);
}
console.log(JSON.stringify({ verified: true, actualSessions: 1, identityMatched: true,
  exportMatchesSession: true, unauthenticatedExportBlocked: true,
  accountReportedInactive: Boolean(job.autoRepairBlocked),
  sessionSha256: crypto.createHash("sha256").update(JSON.stringify(session)).digest("hex") }));
