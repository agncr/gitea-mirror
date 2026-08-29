interface BuildGithubSourceAuthPayloadParams {
  token?: string | null;
  githubOwner?: string | null;
  githubUsername?: string | null;
  repositoryOwner?: string | null;
}

export interface GithubSourceAuthPayload {
  auth_username: string;
  auth_password: string;
  auth_token: string;
}

export type GithubSourceAuthPayloadOrEmpty = GithubSourceAuthPayload | Record<string, never>;

const DEFAULT_GITHUB_AUTH_USERNAME = "x-access-token";
const GITLAB_AUTH_USERNAME = "oauth2";

function normalize(value?: string | null): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Build source credentials for GitHub repository mirroring.
 * GitHub expects username + token-as-password over HTTPS (not the GitLab-style "oauth2" username).
 * Returns an empty object when no token is available, allowing callers to use it unconditionally.
 */
export function buildGithubSourceAuthPayload({
  token,
  githubOwner,
  githubUsername,
  repositoryOwner,
}: BuildGithubSourceAuthPayloadParams): GithubSourceAuthPayloadOrEmpty {
  const normalizedToken = normalize(token);
  if (!normalizedToken) {
    return {};
  }

  const authUsername =
    normalize(githubOwner) ||
    normalize(githubUsername) ||
    normalize(repositoryOwner) ||
    DEFAULT_GITHUB_AUTH_USERNAME;

  return {
    auth_username: authUsername,
    auth_password: normalizedToken,
    auth_token: normalizedToken,
  };
}

/**
 * Build source credentials for GitLab repository mirroring.
 * GitLab requires the literal username "oauth2" with the token as the password
 * over HTTPS; the account name is never used, unlike GitHub.
 * Returns an empty object when no token is available.
 */
export function buildGitlabSourceAuthPayload({
  token,
}: {
  token?: string | null;
}): GithubSourceAuthPayloadOrEmpty {
  const normalizedToken = normalize(token);
  if (!normalizedToken) {
    return {};
  }

  return {
    auth_username: GITLAB_AUTH_USERNAME,
    auth_password: normalizedToken,
    auth_token: normalizedToken,
  };
}

/**
 * Pick the right credential shape for a repository's source forge.
 *
 * The Gitea migration payload itself is provider-agnostic (`service: "git"`),
 * so this is the only place the forges differ when creating a mirror.
 */
export function buildSourceAuthPayload({
  provider,
  githubToken,
  gitlabToken,
  githubOwner,
  githubUsername,
  repositoryOwner,
}: {
  provider: "github" | "gitlab";
  githubToken?: string | null;
  gitlabToken?: string | null;
  githubOwner?: string | null;
  githubUsername?: string | null;
  repositoryOwner?: string | null;
}): GithubSourceAuthPayloadOrEmpty {
  if (provider === "gitlab") {
    return buildGitlabSourceAuthPayload({ token: gitlabToken });
  }

  return buildGithubSourceAuthPayload({
    token: githubToken,
    githubOwner,
    githubUsername,
    repositoryOwner,
  });
}
