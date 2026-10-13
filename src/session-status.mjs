export function sessionExpiryStatus(expiresAt, now = Date.now()) {
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(expires)) return "missing";
  return expires <= now ? "expired" : "valid";
}
