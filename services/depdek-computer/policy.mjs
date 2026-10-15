import { isIP } from "node:net";
export function publicAddress(ip) {
  if (isIP(ip) === 4) {
    const p = ip.split(".").map(Number);
    return !(
      p[0] === 0 ||
      p[0] === 10 ||
      p[0] === 127 ||
      p[0] >= 224 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && (p[1] === 168 || p[1] === 0 || p[1] === 2)) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      (p[0] === 198 && (p[1] === 18 || p[1] === 19 || p[1] === 51)) ||
      (p[0] === 203 && p[1] === 0 && p[2] === 113)
    );
  }
  const s = ip.toLowerCase();
  return (
    isIP(s) === 6 &&
    /^[23]/.test(s) &&
    !s.startsWith("2001:") &&
    !s.startsWith("2002:") &&
    !s.startsWith("3fff:")
  );
}
export function permittedUrl(raw, hosts) {
  const u = new URL(raw);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    (u.port && u.port !== "443") ||
    isIP(u.hostname) ||
    !hosts.includes(u.hostname)
  )
    throw Error("HOST_NOT_ALLOWED");
  return u;
}
