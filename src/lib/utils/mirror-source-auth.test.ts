import { describe, expect, test } from "bun:test";
import {
  buildGithubSourceAuthPayload,
  buildGitlabSourceAuthPayload,
  buildSourceAuthPayload,
} from "./mirror-source-auth";

describe("buildGithubSourceAuthPayload", () => {
  test("uses configured owner when available", () => {
    const auth = buildGithubSourceAuthPayload({
      token: "ghp_test_token",
      githubOwner: "ConfiguredOwner",
      githubUsername: "fallback-user",
      repositoryOwner: "repo-owner",
    });

    expect(auth).toEqual({
      auth_username: "ConfiguredOwner",
      auth_password: "ghp_test_token",
      auth_token: "ghp_test_token",
    });
  });

  test("falls back to configured username then repository owner", () => {
    const authFromUsername = buildGithubSourceAuthPayload({
      token: "token1",
      githubUsername: "configured-user",
      repositoryOwner: "repo-owner",
    });

    expect(authFromUsername.auth_username).toBe("configured-user");

    const authFromRepoOwner = buildGithubSourceAuthPayload({
      token: "token2",
      repositoryOwner: "repo-owner",
    });

    expect(authFromRepoOwner.auth_username).toBe("repo-owner");
  });

  test("uses x-access-token as last-resort username", () => {
    const auth = buildGithubSourceAuthPayload({
      token: "ghp_test_token",
    });

    expect(auth.auth_username).toBe("x-access-token");
  });

  test("trims token whitespace", () => {
    const auth = buildGithubSourceAuthPayload({
      token: "  ghp_trimmed  ",
      githubUsername: "user",
    });

    expect(auth.auth_password).toBe("ghp_trimmed");
    expect(auth.auth_token).toBe("ghp_trimmed");
  });

  test("returns empty object when token is missing", () => {
    const result = buildGithubSourceAuthPayload({
      token: "   ",
      githubUsername: "user",
    });

    expect(result).toEqual({});
  });
});

describe("buildGitlabSourceAuthPayload", () => {
  test("uses the literal oauth2 username GitLab requires", () => {
    const auth = buildGitlabSourceAuthPayload({ token: "glpat_test_token" });

    expect(auth.auth_username).toBe("oauth2");
    expect(auth.auth_password).toBe("glpat_test_token");
    expect(auth.auth_token).toBe("glpat_test_token");
  });

  test("trims token whitespace", () => {
    const auth = buildGitlabSourceAuthPayload({ token: "  glpat_trimmed  " });

    expect(auth.auth_password).toBe("glpat_trimmed");
  });

  test("returns empty object when token is missing", () => {
    expect(buildGitlabSourceAuthPayload({ token: "   " })).toEqual({});
    expect(buildGitlabSourceAuthPayload({ token: null })).toEqual({});
  });
});

describe("buildSourceAuthPayload", () => {
  test("dispatches GitHub repositories to the GitHub credentials", () => {
    const auth = buildSourceAuthPayload({
      provider: "github",
      githubToken: "ghp_token",
      gitlabToken: "glpat_token",
      githubOwner: "ConfiguredOwner",
      repositoryOwner: "someone-else",
    });

    expect(auth.auth_username).toBe("ConfiguredOwner");
    expect(auth.auth_password).toBe("ghp_token");
  });

  test("dispatches GitLab repositories to the GitLab credentials", () => {
    const auth = buildSourceAuthPayload({
      provider: "gitlab",
      githubToken: "ghp_token",
      gitlabToken: "glpat_token",
      githubOwner: "ConfiguredOwner",
      repositoryOwner: "acme-platform",
    });

    expect(auth.auth_username).toBe("oauth2");
    expect(auth.auth_password).toBe("glpat_token");
  });

  test("never leaks the other forge's token", () => {
    const auth = buildSourceAuthPayload({
      provider: "gitlab",
      githubToken: "ghp_should_not_appear",
      gitlabToken: "glpat_token",
    });

    expect(JSON.stringify(auth)).not.toContain("ghp_should_not_appear");
  });

  test("returns empty object when the matching token is absent", () => {
    expect(
      buildSourceAuthPayload({ provider: "gitlab", githubToken: "ghp_token" }),
    ).toEqual({});
  });
});
