const PROTOCOLS = ["http:", "https:", "socks5:", "socks5h:"];

export function normalizeProxyUrl(value) {
  try {
    if (value != null && typeof value !== "string") throw new Error();
    const text = (value ?? "").trim();
    if (!text) return null;
    if (/[\s\x00-\x1f]/.test(text)) throw new Error();
    let parsed;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
      parsed = new URL(text);
    } else {
      // A four-part address cannot tell HTTP from SOCKS; default to HTTP, never probe credentials.
      const parts = /^([^:\s/@?#]+):(\d{1,5}):([^:\s]+):(.+)$/.exec(text);
      if (!parts || Number(parts[2]) < 1 || Number(parts[2]) > 65535) throw new Error();
      parsed = new URL(`http://${parts[1]}:${parts[2]}`);
      parsed.username = encodeURIComponent(parts[3]);
      parsed.password = encodeURIComponent(parts[4]);
    }
    if (!PROTOCOLS.includes(parsed.protocol) || !parsed.hostname || parsed.search || parsed.hash
      || (parsed.pathname && parsed.pathname !== "/")) throw new Error();
    decodeURIComponent(parsed.username);
    decodeURIComponent(parsed.password);
    return parsed.toString();
  } catch {
    const error = new Error("代理格式无效：请使用完整 http(s)/socks5(h) URL，或 主机:端口:用户名:密码（按 HTTP 解析）");
    error.status = 400;
    throw error;
  }
}

export function proxySupportsSessionRotation(value) {
  try {
    const parsed = new URL(normalizeProxyUrl(value));
    return /(^|-)sid-[A-Za-z0-9]+(?=-|$)/.test(decodeURIComponent(parsed.username))
      || /^(.*-[A-Za-z]{2})-([0-9]{8})-(\d+m)$/i.test(decodeURIComponent(parsed.password));
  } catch { return false; }
}

export function normalizeProxyRotation(enabled, proxyUrl) {
  if (typeof enabled !== "boolean" || (enabled && !proxySupportsSessionRotation(proxyUrl))) {
    const error = new Error("轮换开关须为布尔值；开启时代理必须包含可识别的 sid 会话参数");
    error.status = 400;
    throw error;
  }
  return enabled;
}
