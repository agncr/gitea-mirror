import { describe, expect, test } from "bun:test";
import { isPrivateHostname, validateOutboundUrl } from "./outbound-url";

const strict = { allowPrivateTargets: false };
const permissive = { allowPrivateTargets: true };

describe("validateOutboundUrl — scheme", () => {
  test("accepts http and https", () => {
    expect(validateOutboundUrl("https://gitlab.com", permissive).ok).toBe(true);
    expect(validateOutboundUrl("http://gitea.internal:3000", permissive).ok).toBe(true);
  });

  test("rejects schemes that turn a fetch into something else", () => {
    for (const url of [
      "file:///etc/passwd",
      "gopher://example.com",
      "ftp://example.com",
      "data:text/plain,hi",
    ]) {
      const result = validateOutboundUrl(url, permissive);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("http");
    }
  });

  test("rejects unparseable and empty input", () => {
    expect(validateOutboundUrl("not a url", permissive).ok).toBe(false);
    expect(validateOutboundUrl("", permissive).ok).toBe(false);
    expect(validateOutboundUrl("   ", permissive).ok).toBe(false);
  });
});

describe("validateOutboundUrl — URL shape", () => {
  test("rejects embedded credentials, which would be sent to the target", () => {
    const result = validateOutboundUrl("https://user:pass@gitlab.com", permissive);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("credentials");
  });

  test("rejects fragments", () => {
    const result = validateOutboundUrl("https://gitlab.com#frag", permissive);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("fragment");
  });

  test("keeps a sub-path, which self-hosted instances use", () => {
    const result = validateOutboundUrl("https://host.example/gitlab", permissive);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url.pathname).toBe("/gitlab");
  });
});

describe("validateOutboundUrl — private targets", () => {
  test("blocks loopback, private ranges and cloud metadata when disallowed", () => {
    for (const url of [
      "http://localhost:3000",
      "http://127.0.0.1:8080",
      "http://0.0.0.0",
      "http://10.1.2.3",
      "http://172.16.0.1",
      "http://192.168.1.10",
      // The AWS/GCP metadata endpoint is the classic SSRF payoff.
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]:3000",
      "http://gitea.local",
    ]) {
      expect(validateOutboundUrl(url, strict).ok).toBe(false);
    }
  });

  test("allows those same targets when private access is permitted", () => {
    // Self-hosted Gitea at http://gitea:3000 or on a LAN address is the normal
    // deployment, so the default must not break it.
    expect(validateOutboundUrl("http://127.0.0.1:8080", permissive).ok).toBe(true);
    expect(validateOutboundUrl("http://192.168.1.10", permissive).ok).toBe(true);
  });

  test("public hosts stay allowed under the strict policy", () => {
    expect(validateOutboundUrl("https://gitlab.com", strict).ok).toBe(true);
    expect(validateOutboundUrl("https://gitlab.example.com", strict).ok).toBe(true);
    // 172.32 is outside the private 172.16/12 block.
    expect(validateOutboundUrl("http://172.32.0.1", strict).ok).toBe(true);
  });
});

describe("isPrivateHostname", () => {
  test("classifies address literals", () => {
    expect(isPrivateHostname("127.0.0.1")).toBe(true);
    expect(isPrivateHostname("169.254.169.254")).toBe(true);
    expect(isPrivateHostname("fd00::1")).toBe(true);
    expect(isPrivateHostname("8.8.8.8")).toBe(false);
    expect(isPrivateHostname("gitlab.com")).toBe(false);
  });

  test("treats 172.16/12 boundaries correctly", () => {
    expect(isPrivateHostname("172.15.0.1")).toBe(false);
    expect(isPrivateHostname("172.16.0.1")).toBe(true);
    expect(isPrivateHostname("172.31.255.254")).toBe(true);
    expect(isPrivateHostname("172.32.0.1")).toBe(false);
  });
});
