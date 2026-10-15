import { test } from "node:test";
import assert from "node:assert/strict";
import { publicAddress, permittedUrl } from "./policy.mjs";
test("network boundary denies private and unauthorized destinations", () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.2",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.167",
    "::1",
    "::ffff:8.8.8.8",
    "fc00::1",
    "2001:db8::1",
  ])
    assert(!publicAddress(ip));
  assert(publicAddress("1.1.1.1"));
  for (const url of [
    "http://example.com",
    "https://evil.example",
    "https://example.com:8443",
    "https://user:pass@example.com",
  ])
    assert.throws(() => permittedUrl(url, ["example.com"]));
  assert.equal(
    permittedUrl("https://example.com", ["example.com"]).hostname,
    "example.com",
  );
});
