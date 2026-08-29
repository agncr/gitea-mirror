import { describe, expect, test } from "bun:test";
import { POST } from "./index";

describe("POST /api/config notification validation", () => {
  test("returns 400 for invalid notificationConfig payload", async () => {
    const request = new Request("http://localhost/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        githubConfig: { username: "octo", token: "ghp_x" },
        giteaConfig: { url: "https://gitea.example.com", token: "gt_x", username: "octo" },
        scheduleConfig: { enabled: true, interval: 3600 },
        cleanupConfig: { enabled: false, retentionDays: 604800 },
        mirrorOptions: {
          mirrorReleases: false,
          releaseLimit: 10,
          mirrorLFS: false,
          mirrorMetadata: false,
          metadataComponents: {
            issues: false,
            pullRequests: false,
            labels: false,
            milestones: false,
            wiki: false,
          },
        },
        advancedOptions: {
          skipForks: false,
          starredCodeOnly: false,
          autoMirrorStarred: false,
        },
        notificationConfig: {
          enabled: true,
          provider: "invalid-provider",
        },
      }),
    });

    const response = await POST({
      request,
      locals: {
        session: { userId: "user-1" },
      },
    } as any);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.message).toContain("Invalid notificationConfig");
  });
});

/**
 * The GitLab source is stored in its own column and its URL is later fetched by
 * the scheduler, so the save path has to validate it rather than trusting the
 * client. These cases stop at the 400 boundary — they assert the request is
 * rejected before anything is written.
 */
describe("POST /api/config GitLab validation", () => {
  const AUTHED_LOCALS = { session: { userId: "user-1" } };

  function configRequest(gitlabConfig: unknown) {
    return new Request("http://localhost/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        githubConfig: { username: "octo", token: "ghp_x" },
        gitlabConfig,
        giteaConfig: {
          url: "https://gitea.example.com",
          token: "gt_x",
          username: "octo",
        },
        scheduleConfig: { enabled: false, interval: 3600 },
        cleanupConfig: { enabled: false, retentionDays: 604800 },
        mirrorOptions: {
          mirrorReleases: false,
          releaseLimit: 10,
          mirrorLFS: false,
          mirrorMetadata: false,
          metadataComponents: {
            issues: false,
            pullRequests: false,
            labels: false,
            milestones: false,
            wiki: false,
          },
        },
        advancedOptions: {
          skipForks: false,
          starredCodeOnly: false,
          autoMirrorStarred: false,
        },
      }),
    });
  }

  const validGitlab = {
    url: "https://gitlab.example.com",
    token: "glpat-x",
    groups: ["acme"],
    includeSubgroups: true,
    includeOwnProjects: false,
    includeForks: true,
    includeArchived: false,
    includePrivate: true,
    includePublic: true,
  };

  test("rejects a non-http instance URL", async () => {
    const response = await POST({
      request: configRequest({ ...validGitlab, url: "file:///etc/passwd" }),
      locals: AUTHED_LOCALS,
    } as any);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.message).toContain("gitlabConfig");
  });

  test("rejects a URL carrying credentials", async () => {
    const response = await POST({
      request: configRequest({ ...validGitlab, url: "https://u:p@gitlab.example.com" }),
      locals: AUTHED_LOCALS,
    } as any);

    expect(response.status).toBe(400);
  });

  test("rejects a groups value that is not a list of strings", async () => {
    const response = await POST({
      request: configRequest({ ...validGitlab, groups: [42] }),
      locals: AUTHED_LOCALS,
    } as any);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.message).toContain("Invalid gitlabConfig");
  });
});
