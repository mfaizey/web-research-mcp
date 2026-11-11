import { describe, expect, it } from "vitest";
import { ErrorCodes, ResearchError } from "../src/lib/errors.js";
import { assertSafeUrl } from "../src/lib/http.js";

function codeFor(raw: string): string {
  try {
    assertSafeUrl(raw);
    return "ok";
  } catch (error) {
    if (error instanceof ResearchError) return error.code;
    throw error;
  }
}

const blockedAddresses = [
  // Loopback, including numeric and octal shorthand that URL normalises.
  "http://127.0.0.1/",
  "http://127.1/",
  "http://127.255.255.255/",
  "http://2130706433/",
  "http://0x7f000001/",
  "http://0177.0.0.1/",
  "http://0.0.0.0/",

  // Private, link-local, CGNAT, documentation, benchmark, multicast ranges.
  "http://10.0.0.1/",
  "http://10.255.255.255/",
  "http://172.16.0.1/",
  "http://172.31.255.255/",
  "http://192.168.0.1/",
  "http://192.168.255.255/",
  "http://169.254.0.1/",
  "http://169.254.169.254/",
  "http://100.64.0.1/",
  "http://192.0.2.1/",
  "http://198.51.100.1/",
  "http://203.0.113.1/",
  "http://198.18.0.1/",
  "http://224.0.0.1/",
  "http://240.0.0.1/",

  // IPv6 loopback, unique-local, link-local, multicast, documentation.
  "http://[::1]/",
  "http://[::]/",
  "http://[fc00::1]/",
  "http://[fd12:3456::1]/",
  "http://[fe80::1]/",
  "http://[ff02::1]/",
  "http://[2001:db8::1]/",

  // IPv4 hidden inside IPv6 forms.
  "http://[::ffff:127.0.0.1]/",
  "http://[::ffff:10.0.0.1]/",
  "http://[64:ff9b::10.0.0.1]/",
  "http://[2002:7f00:1::]/",

  // Special-use hostnames that should never reach DNS.
  "http://localhost/",
  "http://localhost./",
  "http://app.localhost/",
  "http://printer.local/",
  "http://metadata.internal/",
  "http://router.home/",
  "http://nas.lan/",
  "http://example.test/",
  "http://invalid.invalid/",
];

const publicUrls = [
  "https://example.com/docs",
  "http://example.com",
  "https://docs.example.org",
  "https://sub.example.co.uk",
  "http://8.8.8.8/",
  "http://1.1.1.1/",
  "https://93.184.216.34/",
  "http://11.0.0.1/",
  "http://172.32.0.1/",
  "http://192.169.0.1/",
  "http://[2001:4860:4860::8888]/",
  "http://[2606:4700:4700::1111]/",
  "http://[2a00:1450:4001:81b::200e]/",
];

describe("assertSafeUrl", () => {
  it.each(blockedAddresses)("blocks non-public target %s", (url) => {
    expect(codeFor(url)).toBe(ErrorCodes.BlockedHost);
  });

  it.each(publicUrls)("allows public target %s", (url) => {
    expect(codeFor(url)).toBe("ok");
  });

  it("rejects non-http protocols, credentials, and malformed URLs", () => {
    expect(codeFor("file:///etc/passwd")).toBe(ErrorCodes.InvalidUrl);
    expect(codeFor("ftp://example.com")).toBe(ErrorCodes.InvalidUrl);
    expect(codeFor("gopher://example.com")).toBe(ErrorCodes.InvalidUrl);
    expect(codeFor("https://user:pass@example.com")).toBe(ErrorCodes.InvalidUrl);
    expect(codeFor("https://user@example.com")).toBe(ErrorCodes.InvalidUrl);
    expect(codeFor("not a url")).toBe(ErrorCodes.InvalidUrl);
    expect(codeFor("https://")).toBe(ErrorCodes.InvalidUrl);
  });

  it("returns the parsed URL for public input", () => {
    const url = assertSafeUrl("https://example.com/docs?q=1#top");
    expect(url.hostname).toBe("example.com");
    expect(url.pathname).toBe("/docs");
  });
});
