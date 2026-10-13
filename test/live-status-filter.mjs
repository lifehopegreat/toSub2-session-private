import assert from "node:assert/strict";
import { JOB_STATUS_FILTERS, normalizeJobStatusFilter, matchesJobStatusFilter } from "../src/job-filter.mjs";

// Read-only acceptance using every actual local job; never creates accounts, mails or sessions.
const base = process.env.TOSUB2_LIVE_URL || "http://127.0.0.1:4399";
assert.equal(new URL(base).hostname, "127.0.0.1");
const bootstrap = await fetch(`${base}/api/bootstrap`).then((response) => response.json());
const headers = { "x-console-token": bootstrap.token, "content-type": "application/json" };
async function getPage(status, page = 1) {
  const response = await fetch(`${base}/api/jobs?status=${encodeURIComponent(status)}&page=${page}`, { headers });
  assert.equal(response.status, 200);
  return response.json();
}
const first = await getPage("all");
assert.equal(first.stats.active, 0, "Run the deterministic read-only check when jobs are idle");
assert.equal(first.stats.queued, 0);
const actualJobs = [...first.jobs];
for (let page = 2; page <= first.pagination.totalPages; page++) actualJobs.push(...(await getPage("all", page)).jobs);
assert.equal(actualJobs.length, first.pagination.total);
const counts = {};
for (const { value } of JOB_STATUS_FILTERS) {
  assert.equal(normalizeJobStatusFilter(value), value);
  const expected = actualJobs.filter((job) => matchesJobStatusFilter(job, value));
  const result = await getPage(value);
  assert.equal(result.filter.status, value);
  assert.equal(result.pagination.total, expected.length);
  assert.ok(JSON.stringify(result.selection.map((job) => job.id)) === JSON.stringify(expected.map((job) => job.id)), "Selection must cover all matching pages, not only the current page");
  assert.ok(result.jobs.every((job) => matchesJobStatusFilter(job, value)));
  const collected = [...result.jobs];
  for (let page = 2; page <= result.pagination.totalPages; page++) collected.push(...(await getPage(value, page)).jobs);
  assert.ok(JSON.stringify(collected.map((job) => job.id)) === JSON.stringify(expected.map((job) => job.id)), "Filter before pagination");
  const clamped = await getPage(value, 999);
  assert.equal(clamped.pagination.page, result.pagination.totalPages);
  const emails = actualJobs.slice(0, 5).map((job) => job.email);
  if (emails.length) {
    const response = await fetch(`${base}/api/jobs/query`, { method: "POST", headers, body: JSON.stringify({ emails, status: value }) });
    assert.equal(response.status, 200);
    const combined = await response.json();
    const matching = expected.filter((job) => emails.includes(job.email));
    assert.equal(combined.pagination.total, matching.length);
    assert.ok(JSON.stringify(combined.selection.map((job) => job.id)) === JSON.stringify(matching.map((job) => job.id)), "Email and status filters must intersect");
  }
  counts[value] = expected.length;
}
const invalid = await fetch(`${base}/api/jobs?status=unknown`, { headers });
assert.equal(invalid.status, 400);
assert.throws(() => normalizeJobStatusFilter({}), { status: 400 });
// Actual expires values, evaluated on their exact boundary; no synthetic sessions or saved-state changes.
const withExpiry = actualJobs.find((job) => Number.isFinite(Date.parse(job.sessionExpiresAt)));
if (withExpiry) {
  const expires = Date.parse(withExpiry.sessionExpiresAt);
  assert.ok(matchesJobStatusFilter(withExpiry, "session_valid", expires - 1));
  assert.ok(matchesJobStatusFilter(withExpiry, "session_expired", expires));
  assert.equal(matchesJobStatusFilter(withExpiry, "session_valid", expires), false);
}
for (const job of actualJobs.filter((item) => !Number.isFinite(Date.parse(item.sessionExpiresAt)))) {
  assert.equal(matchesJobStatusFilter(job, "session_expired"), false);
  assert.equal(matchesJobStatusFilter(job, "session_valid"), false);
}
console.log(JSON.stringify({ actualJobs: actualJobs.length, filterCounts: counts, paginationChecked: true,
  emailIntersectionChecked: true, invalidFilterRejected: true, actualExpiryBoundaryChecked: Boolean(withExpiry) }));
