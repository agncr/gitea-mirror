import type { GitRepo, RepoStatus } from "@/types/Repository";
import type { GitOrg } from "@/types/organizations";
import type { MembershipRole } from "@/types/organizations";
import type { Config } from "@/types/config";
import { httpGet, HttpError, type HttpResponse } from "./http-client";

/**
 * Gitea rejects owner names longer than 40 characters, and GitLab group paths
 * nest arbitrarily deep, so flattened names have to be capped.
 */
export const GITEA_MAX_OWNER_LENGTH = 40;

const GITLAB_API_PREFIX = "/api/v4";
const DEFAULT_PER_PAGE = 100;
const MAX_RETRIES = 3;

/** Subset of GitLab's project payload that we actually consume. */
export interface GitlabProject {
  id: number;
  name: string;
  path: string;
  path_with_namespace: string;
  web_url: string;
  http_url_to_repo: string;
  visibility: "public" | "internal" | "private";
  archived?: boolean;
  forked_from_project?: { path_with_namespace?: string } | null;
  default_branch?: string | null;
  description?: string | null;
  issues_enabled?: boolean;
  created_at?: string;
  last_activity_at?: string;
  namespace: {
    id: number;
    name: string;
    path: string;
    full_path: string;
    kind: "group" | "user";
  };
}

export interface GitlabGroup {
  id: number;
  name: string;
  path: string;
  full_path: string;
  avatar_url?: string | null;
  description?: string | null;
}

/**
 * How the client actually performs a request. Defaults to the shared
 * {@link httpGet}; tests inject a fake so they neither hit the network nor
 * depend on the global module mocks other suites install.
 */
export type GitlabTransport = <T = any>(
  url: string,
  headers?: Record<string, string>,
) => Promise<HttpResponse<T>>;

export interface GitlabClient {
  /** Instance root without trailing slash, e.g. "https://gitlab.com". */
  baseUrl: string;
  get<T = any>(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
  ): Promise<HttpResponse<T>>;
  /** Follows GitLab's `x-next-page` header until the last page. */
  getPaginated<T = any>(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
  ): Promise<T[]>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * FNV-1a, rendered base36. Deterministic across processes so an over-long group
 * path keeps the same flattened name on every sync instead of re-importing
 * under a new one.
 */
function shortHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Collapse a nested GitLab group path into a single Gitea-safe owner name:
 * "acme/platform/backend" -> "acme-platform-backend".
 *
 * Gitea has no nested organizations, so flattening here — at discovery time —
 * keeps every downstream consumer on the "owner/repo" single-slash assumption
 * that predates GitLab support. The true GitLab path stays available on the
 * repository's `url` and `cloneUrl`.
 *
 * Distinct paths can still collide after flattening ("a/b-c" and "a-b/c" both
 * give "a-b-c"). This function returns the preferred, readable name;
 * {@link resolveFlattenedOwners} detects actual collisions among a set of paths
 * and disambiguates them.
 */
export function flattenGitlabPath(fullPath: string): string {
  const raw = (fullPath ?? "").trim();
  if (!raw) return "";

  const sanitized = raw
    .replace(/\//g, "-")
    // Gitea owner names allow alphanumerics, dash, dot and underscore only.
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");

  if (!sanitized) return "";
  if (sanitized.length <= GITEA_MAX_OWNER_LENGTH) return sanitized;

  // Hash the original path, not the truncated form, so two long paths sharing a
  // prefix still get different names.
  const suffix = `-${shortHash(raw)}`;
  const keep = Math.max(1, GITEA_MAX_OWNER_LENGTH - suffix.length);
  return sanitized.slice(0, keep).replace(/[-._]+$/g, "") + suffix;
}

/**
 * The disambiguated form of a flattened name: the preferred name, shortened if
 * needed, plus a suffix derived from the FULL path. Two different paths
 * therefore always get two different names.
 */
function disambiguateFlattenedName(fullPath: string, preferred: string): string {
  const suffix = `-${shortHash(fullPath.trim())}`;
  const keep = Math.max(1, GITEA_MAX_OWNER_LENGTH - suffix.length);
  return preferred.slice(0, keep).replace(/[-._]+$/g, "") + suffix;
}

/**
 * Map each GitLab group path to the Gitea owner name it should use.
 *
 * Paths whose preferred name is unique keep that readable name. When two or
 * more distinct paths flatten to the same name, EVERY member of that collision
 * set gets a path-derived suffix — including the first one — so the result
 * depends only on the set of paths, not on iteration order.
 *
 * The alternative, keeping the first and skipping the rest, silently drops a
 * repository from every future sync: a permanent gap in what is supposed to be
 * a backup.
 */
export function resolveFlattenedOwners(fullPaths: Iterable<string>): Map<string, string> {
  const preferredByPath = new Map<string, string>();
  const pathsByPreferred = new Map<string, string[]>();

  for (const rawPath of fullPaths) {
    const path = (rawPath ?? "").trim();
    if (!path || preferredByPath.has(path)) continue;

    const preferred = flattenGitlabPath(path);
    if (!preferred) continue;

    preferredByPath.set(path, preferred);
    const bucket = pathsByPreferred.get(preferred);
    if (bucket) bucket.push(path);
    else pathsByPreferred.set(preferred, [path]);
  }

  const resolved = new Map<string, string>();
  for (const [path, preferred] of preferredByPath) {
    const collidingPaths = pathsByPreferred.get(preferred) ?? [];
    resolved.set(
      path,
      collidingPaths.length > 1 ? disambiguateFlattenedName(path, preferred) : preferred,
    );
  }

  return resolved;
}

/**
 * GitLab access levels are numeric; map them onto the existing GitHub-shaped
 * membership roles rather than widening the enum for v1.
 * 50 = Owner, 40 = Maintainer, 30 = Developer, 20 = Reporter, 10 = Guest.
 */
export function mapGitlabAccessLevel(accessLevel: number | undefined | null): MembershipRole {
  if (typeof accessLevel !== "number") return "member";
  if (accessLevel >= 50) return "owner";
  if (accessLevel >= 40) return "admin";
  return "member";
}

/**
 * Creates a GitLab REST v4 client.
 *
 * Deliberately a thin fetch wrapper rather than an SDK: v1 only reads project
 * and group listings, and this keeps the dependency surface (and the Octokit-
 * shaped coupling that makes the GitHub path hard to reuse) out of the picture.
 */
export function createGitlabClient({
  url,
  token,
  transport,
}: {
  url: string;
  token: string;
  transport?: GitlabTransport;
}): GitlabClient {
  const baseUrl = (url || "https://gitlab.com").trim().replace(/\/+$/, "");
  const request: GitlabTransport = transport ?? httpGet;

  const buildUrl = (
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
  ) => {
    const target = new URL(`${baseUrl}${GITLAB_API_PREFIX}${path}`);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value === undefined) continue;
      target.searchParams.set(key, String(value));
    }
    return target.toString();
  };

  const get = async <T = any>(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
  ): Promise<HttpResponse<T>> => {
    const target = buildUrl(path, params);

    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await request<T>(target, { "PRIVATE-TOKEN": token });
      } catch (error) {
        lastError = error;
        const status = error instanceof HttpError ? error.status : 0;

        // 4xx other than "too many requests" will not improve on retry.
        if (status !== 429 && status < 500) throw error;
        if (attempt === MAX_RETRIES) break;

        const waitMs = 1000 * 2 ** attempt;
        console.warn(
          `[GitLab] ${status || "network error"} for ${path}; retry ${attempt + 1}/${MAX_RETRIES} in ${waitMs}ms`,
        );
        await sleep(waitMs);
      }
    }
    throw lastError;
  };

  const getPaginated = async <T = any>(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
  ): Promise<T[]> => {
    const results: T[] = [];
    let page: string | undefined = "1";

    while (page) {
      const response = await get<T[]>(path, {
        per_page: DEFAULT_PER_PAGE,
        ...params,
        page,
      });

      const batch = Array.isArray(response.data) ? response.data : [];
      results.push(...batch);

      const next = response.headers.get("x-next-page");
      // GitLab sends an empty x-next-page on the final page.
      page = next && next.trim() ? next.trim() : undefined;

      // Defensive: a proxy that strips pagination headers must not loop forever.
      if (batch.length === 0) break;
    }

    return results;
  };

  return { baseUrl, get, getPaginated };
}

/**
 * Projects a GitLab project onto the provider-neutral {@link GitRepo} shape.
 *
 * `name` uses the project's URL slug (`path`) rather than its display name, so
 * the mirrored repository keeps a URL-safe name like GitHub's `name` does.
 */
export function mapGitlabProjectToGitRepo(
  project: GitlabProject,
  /**
   * Owner name resolved across the whole batch, so colliding group paths get
   * distinct names. Falls back to the plain flattened name for single-project
   * callers and tests.
   */
  ownerName?: string,
): GitRepo {
  const owner = ownerName ?? flattenGitlabPath(project.namespace?.full_path ?? "");
  const isGroupProject = project.namespace?.kind === "group";
  const createdAt = project.created_at ? new Date(project.created_at) : new Date();
  const updatedAt = project.last_activity_at
    ? new Date(project.last_activity_at)
    : new Date();

  return {
    name: project.path,
    fullName: `${owner}/${project.path}`,
    url: project.web_url,
    cloneUrl: project.http_url_to_repo,
    provider: "gitlab",

    owner,
    // Personal-namespace projects have no organization, matching how GitHub
    // user repos are represented.
    organization: isGroupProject ? owner : undefined,

    // GitLab's "internal" (any signed-in instance user) has no Gitea
    // equivalent, so it is mirrored as private to avoid over-sharing.
    isPrivate: project.visibility !== "public",
    isForked: Boolean(project.forked_from_project),
    forkedFrom: project.forked_from_project?.path_with_namespace ?? undefined,

    hasIssues: project.issues_enabled ?? false,
    // Starred projects are a GitHub-only concept in this app; GitLab rows are
    // never starred, which also keeps them out of the starred placement path.
    isStarred: false,
    isArchived: Boolean(project.archived),

    size: 0,
    hasLFS: false,
    hasSubmodules: false,

    language: null,
    description: project.description ?? null,
    defaultBranch: project.default_branch || "main",
    visibility: project.visibility,

    status: "imported" as RepoStatus,
    importedAt: new Date(),
    createdAt,
    updatedAt,
  };
}

function passesRepoFilters(
  project: GitlabProject,
  gitlabConfig: NonNullable<Config["gitlabConfig"]>,
): boolean {
  if (!gitlabConfig.includeArchived && project.archived) return false;
  if (!gitlabConfig.includeForks && project.forked_from_project) return false;

  const isPublic = project.visibility === "public";
  if (!gitlabConfig.includePublic && isPublic) return false;
  // "internal" counts as non-public here, same as the mirror visibility mapping.
  if (!gitlabConfig.includePrivate && !isPublic) return false;

  return true;
}

/**
 * Discovers every mirrorable project for the configured GitLab groups.
 *
 * @param includeAllGroupsOverride ignores the group allowlist and lists every
 * project the token can see. Orphan detection needs this: narrowing the
 * allowlist must never make previously mirrored repositories look deleted.
 */
export async function getGitlabRepositories({
  client,
  config,
  includeAllGroupsOverride = false,
}: {
  client: GitlabClient;
  config: Partial<Config>;
  includeAllGroupsOverride?: boolean;
}): Promise<GitRepo[]> {
  const gitlabConfig = config.gitlabConfig;
  if (!gitlabConfig) return [];

  const projectsById = new Map<number, GitlabProject>();

  const collect = (projects: GitlabProject[]) => {
    for (const project of projects) {
      if (!project?.id) continue;
      projectsById.set(project.id, project);
    }
  };

  if (includeAllGroupsOverride) {
    collect(
      await client.getPaginated<GitlabProject>("/projects", {
        membership: true,
      }),
    );
  } else {
    const groupFailures: string[] = [];

    for (const group of gitlabConfig.groups ?? []) {
      const encoded = encodeURIComponent(group);
      try {
        collect(
          await client.getPaginated<GitlabProject>(`/groups/${encoded}/projects`, {
            include_subgroups: gitlabConfig.includeSubgroups ?? true,
            // GitLab includes projects merely SHARED into the group by default,
            // which would pull in repositories from namespaces the user never
            // put on the allowlist.
            with_shared: false,
          }),
        );
      } catch (error) {
        // An auth failure is not "this one group is unreadable" — it means the
        // token is bad or expired, and continuing would report a successful
        // import that found nothing. Fail the whole source instead.
        if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
          throw error;
        }

        // A single genuinely inaccessible group must not abort the import, but
        // it is reported so the caller can surface it rather than silently
        // treating a partial result as complete.
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[GitLab] Failed to list projects for group "${group}": ${message}`);
        groupFailures.push(`${group}: ${message}`);
      }
    }

    if (gitlabConfig.includeOwnProjects) {
      try {
        collect(
          await client.getPaginated<GitlabProject>("/projects", { owned: true }),
        );
      } catch (error) {
        if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[GitLab] Failed to list owned projects: ${message}`);
        groupFailures.push(`owned projects: ${message}`);
      }
    }

    // Every configured group failed and none produced a project: report that
    // rather than returning an empty list that reads as "nothing to mirror".
    if (groupFailures.length > 0 && projectsById.size === 0) {
      throw new Error(
        `Could not list any GitLab projects. ${groupFailures.join("; ")}`,
      );
    }
  }

  const eligible = [...projectsById.values()].filter((project) =>
    passesRepoFilters(project, gitlabConfig),
  );

  // Resolve owner names across the whole batch first: colliding group paths get
  // distinct names rather than one project being dropped.
  const ownerByPath = resolveFlattenedOwners(
    eligible.map((project) => project.namespace?.full_path ?? ""),
  );

  const repos: GitRepo[] = [];
  const seenFullNames = new Set<string>();

  for (const project of eligible) {
    const namespacePath = (project.namespace?.full_path ?? "").trim();
    const repo = mapGitlabProjectToGitRepo(project, ownerByPath.get(namespacePath));
    if (!repo.owner || !repo.name) continue;

    // Only reachable when one GitLab group genuinely holds two projects of the
    // same name, which the API does not allow — kept as a last-resort guard so
    // a surprising payload cannot violate the unique index.
    const key = repo.fullName.toLowerCase();
    if (seenFullNames.has(key)) {
      console.warn(
        `[GitLab] Skipping ${project.path_with_namespace}: "${repo.fullName}" is already present in this batch.`,
      );
      continue;
    }
    seenFullNames.add(key);
    repos.push(repo);
  }

  return repos;
}

/**
 * Lists the configured groups plus, when enabled, their descendants — each
 * becomes its own Gitea organization once flattened.
 *
 * `repositories` supplies the per-group counts so this does not re-list every
 * project.
 */
export async function getGitlabGroups({
  client,
  config,
  repositories = [],
  currentUserId,
}: {
  client: GitlabClient;
  config: Partial<Config>;
  repositories?: GitRepo[];
  currentUserId?: number;
}): Promise<{
  organizations: GitOrg[];
  failedGroups: { name: string; avatarUrl: string; reason: string }[];
}> {
  const gitlabConfig = config.gitlabConfig;
  if (!gitlabConfig) return { organizations: [], failedGroups: [] };

  const failedGroups: { name: string; avatarUrl: string; reason: string }[] = [];
  const groupsByPath = new Map<string, GitlabGroup>();

  for (const groupPath of gitlabConfig.groups ?? []) {
    const encoded = encodeURIComponent(groupPath);
    try {
      const { data: group } = await client.get<GitlabGroup>(`/groups/${encoded}`);
      groupsByPath.set(group.full_path, group);

      if (gitlabConfig.includeSubgroups ?? true) {
        // descendant_groups covers every nesting level, unlike /subgroups which
        // only returns direct children.
        const descendants = await client.getPaginated<GitlabGroup>(
          `/groups/${group.id}/descendant_groups`,
        );
        for (const descendant of descendants) {
          groupsByPath.set(descendant.full_path, descendant);
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[GitLab] Failed to load group "${groupPath}": ${reason}`);
      failedGroups.push({ name: groupPath, avatarUrl: "", reason });
    }
  }

  // Repository counts keyed by the same flattened owner the orgs will use.
  const repoCounts = new Map<string, { total: number; public: number; private: number; forks: number }>();
  for (const repo of repositories) {
    if (repo.provider !== "gitlab") continue;
    const bucket = repoCounts.get(repo.owner) ?? { total: 0, public: 0, private: 0, forks: 0 };
    bucket.total += 1;
    if (repo.isPrivate) bucket.private += 1;
    else bucket.public += 1;
    if (repo.isForked) bucket.forks += 1;
    repoCounts.set(repo.owner, bucket);
  }

  // Same resolution as the repository path, so an organization and the repos
  // placed under it always agree on the flattened name.
  const ownerByPath = resolveFlattenedOwners(
    [...groupsByPath.values()].map((group) => group.full_path),
  );

  const organizations: GitOrg[] = [];
  const seenOrgNames = new Set<string>();
  for (const group of groupsByPath.values()) {
    const name = ownerByPath.get((group.full_path ?? "").trim());
    if (!name) continue;

    // Defence in depth for the batch insert, which has no per-row error
    // handling: a duplicate would abort the whole import transaction.
    if (seenOrgNames.has(name.toLowerCase())) continue;
    seenOrgNames.add(name.toLowerCase());

    let membershipRole: MembershipRole = "member";
    if (currentUserId) {
      try {
        const { data: member } = await client.get<{ access_level?: number }>(
          `/groups/${group.id}/members/all/${currentUserId}`,
        );
        membershipRole = mapGitlabAccessLevel(member?.access_level);
      } catch {
        // Access level is cosmetic; a failure here must not drop the group.
      }
    }

    const counts = repoCounts.get(name);
    organizations.push({
      name,
      provider: "gitlab",
      avatarUrl: group.avatar_url ?? "",
      membershipRole,
      isIncluded: false,
      status: "imported" as RepoStatus,
      repositoryCount: counts?.total ?? 0,
      publicRepositoryCount: counts?.public ?? 0,
      privateRepositoryCount: counts?.private ?? 0,
      forkRepositoryCount: counts?.forks ?? 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  return { organizations, failedGroups };
}

/**
 * Recovers a project's real GitLab path ("acme/platform/api") from its stored
 * web or clone URL.
 *
 * Orphan checks must not use the repository's `fullName`: that holds the
 * FLATTENED owner ("acme-platform/api"), which GitLab would not resolve.
 *
 * `instanceUrl` lets a self-hosted instance served under a sub-path
 * (relative_url_root) strip that prefix.
 */
export function gitlabProjectPathFromUrl(repoUrl: string, instanceUrl?: string): string {
  if (!repoUrl) return "";
  try {
    const parsed = new URL(repoUrl);
    let path = parsed.pathname;

    if (instanceUrl) {
      try {
        const basePath = new URL(instanceUrl).pathname.replace(/\/+$/, "");
        if (basePath && basePath !== "/" && path.startsWith(basePath)) {
          path = path.slice(basePath.length);
        }
      } catch {
        // A malformed instance URL just means no prefix to strip.
      }
    }

    return path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");
  } catch {
    return "";
  }
}

/**
 * Targeted existence check for orphan detection.
 *
 * Returns `true` when the project exists, `false` only on a clean 404, and
 * `null` when the answer is unknown (network error, rate limit, 5xx). Callers
 * must treat `null` as "not orphaned" — the same fail-safe rule the GitHub
 * path follows, so a transient outage never deletes mirrors.
 */
export async function gitlabProjectExists({
  client,
  projectPath,
}: {
  client: GitlabClient;
  projectPath: string;
}): Promise<boolean | null> {
  if (!projectPath) return null;

  try {
    await client.get(`/projects/${encodeURIComponent(projectPath)}`);
    return true;
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      return false;
    }
    console.warn(
      `[GitLab] Existence check for "${projectPath}" failed with a non-404 error; treating as still present: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

/**
 * Verifies credentials and returns the authenticated account, used by the
 * config UI's "Test" button and to resolve group membership levels.
 */
export async function testGitlabConnection({
  url,
  token,
  transport,
}: {
  url: string;
  token: string;
  transport?: GitlabTransport;
}): Promise<{ id: number; username: string; name?: string; avatarUrl?: string }> {
  const client = createGitlabClient({ url, token, transport });
  const { data } = await client.get<{
    id: number;
    username: string;
    name?: string;
    avatar_url?: string;
  }>("/user");

  return {
    id: data.id,
    username: data.username,
    name: data.name,
    avatarUrl: data.avatar_url,
  };
}
