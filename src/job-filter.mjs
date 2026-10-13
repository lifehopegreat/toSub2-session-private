import { sessionExpiryStatus } from "./session-status.mjs";

export const JOB_STATUS_FILTERS = [
  { value: "all", label: "全部状态" },
  { value: "failed", label: "失败" },
  { value: "completed", label: "已完成" },
  { value: "session_expired", label: "Session 已到期" },
  { value: "session_valid", label: "Session 未到期" },
];

export function normalizeJobStatusFilter(value = "all") {
  if (!JOB_STATUS_FILTERS.some((filter) => filter.value === value)) {
    const error = new Error("账号状态筛选无效");
    error.status = 400;
    throw error;
  }
  return value;
}

export function matchesJobStatusFilter(job, filter, now = Date.now()) {
  if (filter === "all") return true;
  if (filter === "failed" || filter === "completed") return job.status === filter;
  const expiry = sessionExpiryStatus(job.sessionExpiresAt, now);
  if (filter === "session_expired") return expiry === "expired";
  if (filter === "session_valid") return expiry === "valid";
  return false;
}
