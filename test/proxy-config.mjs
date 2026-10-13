import assert from "node:assert/strict";
import { normalizeProxyUrl, normalizeProxyRotation, proxySupportsSessionRotation } from "../src/proxy-config.mjs";
import { rotateProxySession, TlsFingerprintTransport } from "../src/tls-transport.mjs";
import { sessionExpiryStatus } from "../src/session-status.mjs";

// Pure format checks only: no proxy connection, no synthetic account/session responses, no real credentials.
const raw = "example.com:3010:user-region-Rand-sid-AbCd1234-t-5:p@ss:%word";
const normalized = normalizeProxyUrl(raw);
const original = new URL(normalized);
assert.equal(original.protocol, "http:");
assert.equal(original.host, "example.com:3010");
assert.equal(decodeURIComponent(original.password), "p@ss:%word");
assert.equal(normalizeProxyUrl(normalized), normalized);
assert.ok(proxySupportsSessionRotation(raw));
assert.equal(normalizeProxyRotation(true, normalized), true);
assert.equal(normalizeProxyRotation(false, normalized), false);
assert.equal(new TlsFingerprintTransport({ proxyRotation: false }).proxyRotation, false);
const rotated = new URL(rotateProxySession(normalized));
assert.equal(rotated.host, original.host);
assert.equal(rotated.password, original.password);
assert.notEqual(rotated.username, original.username);
assert.match(decodeURIComponent(rotated.username), /^user-region-Rand-sid-[A-Za-z0-9]{8}-t-5$/);
for (const value of [false, {}, "example.com:0:u:p", "example.com:65536:u:p", "bad input", "ftp://example.com", "http://example.com/path", "http://u:p%word@example.com"] ) {
  assert.throws(() => normalizeProxyUrl(value), { status: 400 });
}
assert.equal(normalizeProxyUrl(""), null);
assert.ok(proxySupportsSessionRotation("socks5h://user-sid-AbCd1234:p@example.com:1080"));
assert.equal(proxySupportsSessionRotation("http://user:p@example.com:3010"), false);
assert.throws(() => normalizeProxyRotation(true, "http://user:p@example.com:3010"), { status: 400 });
assert.throws(() => normalizeProxyRotation("false", normalized), { status: 400 });
assert.equal(sessionExpiryStatus(null), "missing");
assert.equal(sessionExpiryStatus("invalid"), "missing");
console.log("Proxy format, rotation switch, credential encoding and missing-expiry checks passed; no network was contacted.");
