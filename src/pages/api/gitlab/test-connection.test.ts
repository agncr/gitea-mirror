import { describe, test, expect, mock } from "bun:test";

/**
 * The route is the SSRF-relevant one: it takes an arbitrary instance URL and
 * makes the server request it with a caller-supplied token. These tests cover
 * the two guards that keep that from being an attack primitive — authentication
 * and server-side URL validation — and assert that no outbound request is made
 * when either rejects.
 */

let outboundCalls: string[] = [];

mock.module("@/lib/gitlab", () => ({
  testGitlabConnection: async ({ url }: { url: string }) => {
    outboundCalls.push(url);
    return { id: 1, username: "ada", name: "Ada" };
  },
}));

const { POST } = await import("./test-connection");

const AUTHED_LOCALS = { session: { userId: "user-1" } };

function requestFor(body: Record<string, unknown>) {
  return new Request("http://localhost/api/gitlab/test-connection", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GitLab test-connection — authentication", () => {
  test("rejects an anonymous caller before reaching out", async () => {
    outboundCalls = [];

    const response = await POST({
      request: requestFor({ token: "glpat-x", url: "http://169.254.169.254" }),
      locals: {},
    } as any);

    expect(response.status).toBe(401);
    // The decisive assertion: nothing was fetched on the caller's behalf.
    expect(outboundCalls).toEqual([]);
  });
});

describe("GitLab test-connection — URL validation", () => {
  test("rejects a non-http scheme", async () => {
    outboundCalls = [];

    const response = await POST({
      request: requestFor({ token: "glpat-x", url: "file:///etc/passwd" }),
      locals: AUTHED_LOCALS,
    } as any);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.message).toContain("http");
    expect(outboundCalls).toEqual([]);
  });

  test("rejects credentials embedded in the URL", async () => {
    outboundCalls = [];

    const response = await POST({
      request: requestFor({ token: "glpat-x", url: "https://user:pw@gitlab.com" }),
      locals: AUTHED_LOCALS,
    } as any);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.message).toContain("credentials");
    expect(outboundCalls).toEqual([]);
  });

  test("still requires a token", async () => {
    outboundCalls = [];

    const response = await POST({
      request: requestFor({ url: "https://gitlab.com" }),
      locals: AUTHED_LOCALS,
    } as any);

    expect(response.status).toBe(400);
    expect(outboundCalls).toEqual([]);
  });

  test("accepts a valid instance URL for an authenticated caller", async () => {
    outboundCalls = [];

    const response = await POST({
      request: requestFor({ token: "glpat-x", url: "https://gitlab.example.com" }),
      locals: AUTHED_LOCALS,
    } as any);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(outboundCalls).toEqual(["https://gitlab.example.com"]);
  });

  test("defaults to gitlab.com when no URL is supplied", async () => {
    outboundCalls = [];

    await POST({
      request: requestFor({ token: "glpat-x" }),
      locals: AUTHED_LOCALS,
    } as any);

    expect(outboundCalls).toEqual(["https://gitlab.com"]);
  });
});
