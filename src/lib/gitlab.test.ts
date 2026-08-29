import { describe, expect, test } from "bun:test";
import {
  GITEA_MAX_OWNER_LENGTH,
  createGitlabClient,
  flattenGitlabPath,
  getGitlabRepositories,
  mapGitlabAccessLevel,
  mapGitlabProjectToGitRepo,
  testGitlabConnection,
  gitlabProjectExists,
  gitlabProjectPathFromUrl,
  resolveFlattenedOwners,
  type GitlabProject,
  type GitlabTransport,
} from "./gitlab";
import { HttpError, type HttpResponse } from "./http-client";
import type { Config } from "@/types/config";

interface Route {
  body: any;
  headers?: Record<string, string>;
  status?: number;
}

interface TransportSpy {
  transport: GitlabTransport;
  /** Every requested URL, in order. */
  calls: string[];
  /** Headers of the most recent request. */
  lastHeaders: Record<string, string>;
}

/**
 * Injects a fake transport instead of stubbing global fetch: other suites
 * install a process-wide `mock.module("@/lib/http-client")`, so the real
 * request path is not reliably reachable from here.
 */
function stubTransport(routes: Record<string, Route>): TransportSpy {
  const spy: TransportSpy = {
    calls: [],
    lastHeaders: {},
    transport: undefined as unknown as GitlabTransport,
  };

  spy.transport = (async (url: string, headers?: Record<string, string>) => {
    spy.calls.push(url);
    spy.lastHeaders = headers ?? {};

    const route = routes[new URL(url).pathname];
    if (!route) {
      throw new HttpError("HTTP 404: 404 Not Found", 404, "Not Found");
    }
    const status = route.status ?? 200;
    if (status >= 400) {
      throw new HttpError(`HTTP ${status}`, status, "Error");
    }

    return {
      data: route.body,
      status,
      statusText: "OK",
      headers: new Headers({
        "content-type": "application/json",
        ...(route.headers ?? {}),
      }),
    } as HttpResponse;
  }) as GitlabTransport;

  return spy;
}

function gitlabConfig(overrides: Partial<NonNullable<Config["gitlabConfig"]>> = {}) {
  return {
    gitlabConfig: {
      url: "https://gitlab.example.com",
      token: "glpat-test",
      groups: ["acme"],
      includeSubgroups: true,
      includeOwnProjects: false,
      includeForks: true,
      includeArchived: false,
      includePrivate: true,
      includePublic: true,
      ...overrides,
    },
  } as Partial<Config>;
}

function project(overrides: Partial<GitlabProject> = {}): GitlabProject {
  return {
    id: 1,
    name: "API Service",
    path: "api-service",
    path_with_namespace: "acme/api-service",
    web_url: "https://gitlab.example.com/acme/api-service",
    http_url_to_repo: "https://gitlab.example.com/acme/api-service.git",
    visibility: "private",
    archived: false,
    default_branch: "main",
    description: "The API",
    issues_enabled: true,
    namespace: { id: 9, name: "Acme", path: "acme", full_path: "acme", kind: "group" },
    ...overrides,
  };
}

describe("flattenGitlabPath", () => {
  test("joins nested group segments with dashes", () => {
    expect(flattenGitlabPath("acme/platform/backend")).toBe("acme-platform-backend");
  });

  test("passes through a top-level group unchanged", () => {
    expect(flattenGitlabPath("acme")).toBe("acme");
  });

  test("replaces characters Gitea does not allow in owner names", () => {
    expect(flattenGitlabPath("acme/r&d team")).toBe("acme-r-d-team");
  });

  test("trims leading and trailing separators", () => {
    expect(flattenGitlabPath("/acme/platform/")).toBe("acme-platform");
  });

  test("returns empty string for blank input", () => {
    expect(flattenGitlabPath("")).toBe("");
    expect(flattenGitlabPath("   ")).toBe("");
  });

  test("caps names at Gitea's owner length limit", () => {
    const deep = "averyverylonggroupname/anotherlongsubgroup/andathirdlevelhere";
    const result = flattenGitlabPath(deep);
    expect(result.length).toBeLessThanOrEqual(GITEA_MAX_OWNER_LENGTH);
  });

  test("is deterministic, so a repo keeps its name across syncs", () => {
    const deep = "averyverylonggroupname/anotherlongsubgroup/andathirdlevelhere";
    expect(flattenGitlabPath(deep)).toBe(flattenGitlabPath(deep));
  });

  test("distinguishes long paths that share a prefix", () => {
    const a = flattenGitlabPath("averyverylonggroupname/anotherlongsubgroup/alpha");
    const b = flattenGitlabPath("averyverylonggroupname/anotherlongsubgroup/beta");
    expect(a).not.toBe(b);
  });
});

describe("mapGitlabAccessLevel", () => {
  test("maps GitLab access levels onto membership roles", () => {
    expect(mapGitlabAccessLevel(50)).toBe("owner");
    expect(mapGitlabAccessLevel(40)).toBe("admin");
    expect(mapGitlabAccessLevel(30)).toBe("member");
    expect(mapGitlabAccessLevel(10)).toBe("member");
    expect(mapGitlabAccessLevel(undefined)).toBe("member");
  });
});

describe("mapGitlabProjectToGitRepo", () => {
  test("flattens the namespace into owner and fullName", () => {
    const repo = mapGitlabProjectToGitRepo(
      project({
        path_with_namespace: "acme/platform/api-service",
        namespace: {
          id: 3,
          name: "Platform",
          path: "platform",
          full_path: "acme/platform",
          kind: "group",
        },
      }),
    );

    expect(repo.owner).toBe("acme-platform");
    expect(repo.organization).toBe("acme-platform");
    expect(repo.fullName).toBe("acme-platform/api-service");
    expect(repo.provider).toBe("gitlab");
  });

  test("keeps the real GitLab URLs, which carry the true nested path", () => {
    const repo = mapGitlabProjectToGitRepo(project());
    expect(repo.url).toBe("https://gitlab.example.com/acme/api-service");
    expect(repo.cloneUrl).toBe("https://gitlab.example.com/acme/api-service.git");
  });

  test("treats internal visibility as private but preserves the label", () => {
    const repo = mapGitlabProjectToGitRepo(project({ visibility: "internal" }));
    expect(repo.isPrivate).toBe(true);
    expect(repo.visibility).toBe("internal");
  });

  test("public projects are not private", () => {
    const repo = mapGitlabProjectToGitRepo(project({ visibility: "public" }));
    expect(repo.isPrivate).toBe(false);
  });

  test("personal-namespace projects have no organization", () => {
    const repo = mapGitlabProjectToGitRepo(
      project({
        namespace: { id: 4, name: "Ada", path: "ada", full_path: "ada", kind: "user" },
      }),
    );
    expect(repo.organization).toBeUndefined();
    expect(repo.owner).toBe("ada");
  });

  test("records fork origin", () => {
    const repo = mapGitlabProjectToGitRepo(
      project({ forked_from_project: { path_with_namespace: "upstream/api-service" } }),
    );
    expect(repo.isForked).toBe(true);
    expect(repo.forkedFrom).toBe("upstream/api-service");
  });

  test("gitlab repos are never starred", () => {
    expect(mapGitlabProjectToGitRepo(project()).isStarred).toBe(false);
  });

  test("falls back to main when the project has no default branch", () => {
    expect(mapGitlabProjectToGitRepo(project({ default_branch: null })).defaultBranch).toBe("main");
  });
});

describe("createGitlabClient", () => {
  test("follows x-next-page until the last page", async () => {
    let page = 0;
    const transport = (async () => {
      page += 1;
      const isLast = page === 2;
      return {
        data: [{ id: page }],
        status: 200,
        statusText: "OK",
        headers: new Headers({ "x-next-page": isLast ? "" : String(page + 1) }),
      } as HttpResponse;
    }) as GitlabTransport;

    const client = createGitlabClient({
      url: "https://gitlab.example.com",
      token: "t",
      transport,
    });
    const results = await client.getPaginated("/groups/acme/projects");

    expect(results).toHaveLength(2);
    expect(page).toBe(2);
  });

  test("stops paginating when a page comes back empty", async () => {
    let requests = 0;
    // A proxy that strips pagination headers must not cause an endless loop.
    const transport = (async () => {
      requests += 1;
      return {
        data: [],
        status: 200,
        statusText: "OK",
        headers: new Headers({ "x-next-page": "2" }),
      } as HttpResponse;
    }) as GitlabTransport;

    const client = createGitlabClient({
      url: "https://gitlab.example.com",
      token: "t",
      transport,
    });
    await client.getPaginated("/groups/acme/projects");

    expect(requests).toBe(1);
  });

  test("sends the token as a PRIVATE-TOKEN header", async () => {
    const spy = stubTransport({ "/api/v4/user": { body: { id: 1, username: "ada" } } });

    await testGitlabConnection({
      url: "https://gitlab.example.com",
      token: "glpat-secret",
      transport: spy.transport,
    });

    expect(spy.lastHeaders["PRIVATE-TOKEN"]).toBe("glpat-secret");
  });

  test("strips a trailing slash from the instance URL", async () => {
    const spy = stubTransport({ "/api/v4/user": { body: { id: 1, username: "ada" } } });

    await testGitlabConnection({
      url: "https://gitlab.example.com/",
      token: "t",
      transport: spy.transport,
    });

    expect(spy.calls[0]).toBe("https://gitlab.example.com/api/v4/user");
  });

  test("returns the authenticated account", async () => {
    const spy = stubTransport({
      "/api/v4/user": { body: { id: 42, username: "ada", name: "Ada L." } },
    });

    const user = await testGitlabConnection({
      url: "https://gitlab.example.com",
      token: "t",
      transport: spy.transport,
    });

    expect(user).toMatchObject({ id: 42, username: "ada", name: "Ada L." });
  });
});

describe("getGitlabRepositories", () => {
  test("requests subgroup projects for each configured group", async () => {
    const spy = stubTransport({
      "/api/v4/groups/acme/projects": { body: [project()] },
    });

    const repos = await getGitlabRepositories({
      client: createGitlabClient({ url: "https://gitlab.example.com", token: "t", transport: spy.transport }),
      config: gitlabConfig(),
    });

    expect(repos).toHaveLength(1);
    expect(spy.calls[0]).toContain("include_subgroups=true");
  });

  test("omits subgroups when the option is off", async () => {
    const spy = stubTransport({
      "/api/v4/groups/acme/projects": { body: [project()] },
    });

    await getGitlabRepositories({
      client: createGitlabClient({ url: "https://gitlab.example.com", token: "t", transport: spy.transport }),
      config: gitlabConfig({ includeSubgroups: false }),
    });

    expect(spy.calls[0]).toContain("include_subgroups=false");
  });

  test("drops archived projects unless they are requested", async () => {
    const spy = stubTransport({
      "/api/v4/groups/acme/projects": {
        body: [project(), project({ id: 2, path: "old", archived: true })],
      },
    });

    const repos = await getGitlabRepositories({
      client: createGitlabClient({ url: "https://gitlab.example.com", token: "t", transport: spy.transport }),
      config: gitlabConfig(),
    });

    expect(repos.map((r) => r.name)).toEqual(["api-service"]);
  });

  test("drops forks when includeForks is off", async () => {
    const spy = stubTransport({
      "/api/v4/groups/acme/projects": {
        body: [
          project(),
          project({
            id: 2,
            path: "forked",
            forked_from_project: { path_with_namespace: "upstream/forked" },
          }),
        ],
      },
    });

    const repos = await getGitlabRepositories({
      client: createGitlabClient({ url: "https://gitlab.example.com", token: "t", transport: spy.transport }),
      config: gitlabConfig({ includeForks: false }),
    });

    expect(repos.map((r) => r.name)).toEqual(["api-service"]);
  });

  test("drops private projects when includePrivate is off", async () => {
    const spy = stubTransport({
      "/api/v4/groups/acme/projects": {
        body: [
          project({ visibility: "private" }),
          project({ id: 2, path: "open", visibility: "public" }),
        ],
      },
    });

    const repos = await getGitlabRepositories({
      client: createGitlabClient({ url: "https://gitlab.example.com", token: "t", transport: spy.transport }),
      config: gitlabConfig({ includePrivate: false }),
    });

    expect(repos.map((r) => r.name)).toEqual(["open"]);
  });

  test("keeps both projects when two paths flatten to the same name", async () => {
    const spy = stubTransport({
      "/api/v4/groups/acme/projects": {
        body: [
          project({
            id: 1,
            path: "svc",
            namespace: { id: 1, name: "b-c", path: "b-c", full_path: "a/b-c", kind: "group" },
          }),
          project({
            id: 2,
            path: "svc",
            namespace: { id: 2, name: "c", path: "c", full_path: "a-b/c", kind: "group" },
          }),
        ],
      },
    });

    const repos = await getGitlabRepositories({
      client: createGitlabClient({ url: "https://gitlab.example.com", token: "t", transport: spy.transport }),
      config: gitlabConfig(),
    });

    // Dropping one would be a permanent gap in the backup, so both are kept
    // and disambiguated instead.
    expect(repos).toHaveLength(2);
    const names = repos.map((r) => r.fullName);
    expect(new Set(names).size).toBe(2);
    for (const name of names) {
      expect(name.endsWith("/svc")).toBe(true);
    }
  });

  test("an inaccessible group does not abort the whole import", async () => {
    const spy = stubTransport({
      "/api/v4/groups/other/projects": { body: [project({ id: 7, path: "kept" })] },
    });

    const repos = await getGitlabRepositories({
      client: createGitlabClient({ url: "https://gitlab.example.com", token: "t", transport: spy.transport }),
      config: gitlabConfig({ groups: ["missing", "other"] }),
    });

    expect(repos.map((r) => r.name)).toEqual(["kept"]);
  });

  test("the override lists all membership projects instead of the allowlist", async () => {
    const spy = stubTransport({
      "/api/v4/projects": { body: [project()] },
    });

    const repos = await getGitlabRepositories({
      client: createGitlabClient({ url: "https://gitlab.example.com", token: "t", transport: spy.transport }),
      config: gitlabConfig({ groups: ["acme"] }),
      includeAllGroupsOverride: true,
    });

    expect(repos).toHaveLength(1);
    expect(spy.calls[0]).toContain("membership=true");
    expect(spy.calls.some((c) => c.includes("/groups/"))).toBe(false);
  });

  test("returns nothing when GitLab is not configured", async () => {
    const spy = stubTransport({});
    const repos = await getGitlabRepositories({
      client: createGitlabClient({ url: "https://gitlab.example.com", token: "t", transport: spy.transport }),
      config: {},
    });
    expect(repos).toEqual([]);
  });
});

describe("gitlabProjectPathFromUrl", () => {
  test("recovers the true nested path, not the flattened owner", () => {
    // The repository row stores owner "acme-platform"; GitLab only resolves
    // the real "acme/platform" path.
    expect(
      gitlabProjectPathFromUrl("https://gitlab.example.com/acme/platform/api-service"),
    ).toBe("acme/platform/api-service");
  });

  test("strips a .git suffix from clone URLs", () => {
    expect(
      gitlabProjectPathFromUrl("https://gitlab.example.com/acme/api-service.git"),
    ).toBe("acme/api-service");
  });

  test("strips a self-hosted sub-path prefix", () => {
    expect(
      gitlabProjectPathFromUrl(
        "https://host.example.com/gitlab/acme/api-service",
        "https://host.example.com/gitlab",
      ),
    ).toBe("acme/api-service");
  });

  test("returns empty string for unusable input", () => {
    expect(gitlabProjectPathFromUrl("")).toBe("");
    expect(gitlabProjectPathFromUrl("not a url")).toBe("");
  });
});

describe("gitlabProjectExists", () => {
  test("reports true when the project resolves", async () => {
    const spy = stubTransport({
      "/api/v4/projects/acme%2Fapi-service": { body: { id: 1 } },
    });

    const exists = await gitlabProjectExists({
      client: createGitlabClient({
        url: "https://gitlab.example.com",
        token: "t",
        transport: spy.transport,
      }),
      projectPath: "acme/api-service",
    });

    expect(exists).toBe(true);
  });

  test("reports false only on a clean 404", async () => {
    const spy = stubTransport({});

    const exists = await gitlabProjectExists({
      client: createGitlabClient({
        url: "https://gitlab.example.com",
        token: "t",
        transport: spy.transport,
      }),
      projectPath: "acme/gone",
    });

    expect(exists).toBe(false);
  });

  test("returns null on a server error so cleanup fails safe", async () => {
    const spy = stubTransport({
      "/api/v4/projects/acme%2Fapi-service": { body: {}, status: 500 },
    });

    const exists = await gitlabProjectExists({
      client: createGitlabClient({
        url: "https://gitlab.example.com",
        token: "t",
        transport: spy.transport,
      }),
      projectPath: "acme/api-service",
    });

    // null must never be read as "gone" — that is what protects live mirrors
    // during a GitLab outage.
    expect(exists).toBeNull();
  });

  test("returns null for an empty path rather than guessing", async () => {
    const spy = stubTransport({});
    const exists = await gitlabProjectExists({
      client: createGitlabClient({
        url: "https://gitlab.example.com",
        token: "t",
        transport: spy.transport,
      }),
      projectPath: "",
    });
    expect(exists).toBeNull();
  });
});

describe("resolveFlattenedOwners", () => {
  test("keeps the readable name when nothing collides", () => {
    const resolved = resolveFlattenedOwners(["acme", "acme/platform"]);
    expect(resolved.get("acme")).toBe("acme");
    expect(resolved.get("acme/platform")).toBe("acme-platform");
  });

  test("disambiguates every member of a collision set, not just the losers", () => {
    // Order-independence is the point: whichever path is seen first, both end
    // up with the same names, so a later sync cannot rename an existing mirror.
    const resolved = resolveFlattenedOwners(["a/b-c", "a-b/c"]);
    const first = resolved.get("a/b-c")!;
    const second = resolved.get("a-b/c")!;

    expect(first).not.toBe(second);
    expect(first).not.toBe("a-b-c");
    expect(second).not.toBe("a-b-c");
  });

  test("produces the same mapping regardless of input order", () => {
    const forward = resolveFlattenedOwners(["a/b-c", "a-b/c"]);
    const reverse = resolveFlattenedOwners(["a-b/c", "a/b-c"]);

    expect(forward.get("a/b-c")).toBe(reverse.get("a/b-c"));
    expect(forward.get("a-b/c")).toBe(reverse.get("a-b/c"));
  });

  test("stays within Gitea's owner length limit when disambiguating", () => {
    const long = "averyverylonggroupname/anotherlongsubgroup-x";
    const other = "averyverylonggroupname-anotherlongsubgroup/x";
    const resolved = resolveFlattenedOwners([long, other]);

    for (const name of resolved.values()) {
      expect(name.length).toBeLessThanOrEqual(GITEA_MAX_OWNER_LENGTH);
    }
  });

  test("ignores blank paths", () => {
    const resolved = resolveFlattenedOwners(["", "   ", "acme"]);
    expect(resolved.size).toBe(1);
    expect(resolved.get("acme")).toBe("acme");
  });
});

describe("getGitlabRepositories — error handling", () => {
  test("excludes projects merely shared into the group", async () => {
    const spy = stubTransport({
      "/api/v4/groups/acme/projects": { body: [project()] },
    });

    await getGitlabRepositories({
      client: createGitlabClient({
        url: "https://gitlab.example.com",
        token: "t",
        transport: spy.transport,
      }),
      config: gitlabConfig(),
    });

    // Otherwise the group allowlist silently widens to other namespaces.
    expect(spy.calls[0]).toContain("with_shared=false");
  });

  test("an expired token fails the whole source instead of reporting success", async () => {
    const transport = (async () => {
      throw new HttpError("HTTP 401", 401, "Unauthorized");
    }) as GitlabTransport;

    const promise = getGitlabRepositories({
      client: createGitlabClient({
        url: "https://gitlab.example.com",
        token: "expired",
        transport,
      }),
      config: gitlabConfig(),
    });

    // Swallowing this would import zero repositories and call it a success,
    // which later reads as "everything is mirrored".
    expect(promise).rejects.toThrow();
  });

  test("throws when every configured group is unreadable", async () => {
    const spy = stubTransport({}); // all routes 404

    const promise = getGitlabRepositories({
      client: createGitlabClient({
        url: "https://gitlab.example.com",
        token: "t",
        transport: spy.transport,
      }),
      config: gitlabConfig({ groups: ["missing-a", "missing-b"] }),
    });

    expect(promise).rejects.toThrow(/Could not list any GitLab projects/);
  });

  test("still succeeds when one group fails but another yields projects", async () => {
    const spy = stubTransport({
      "/api/v4/groups/other/projects": { body: [project({ id: 7, path: "kept" })] },
    });

    const repos = await getGitlabRepositories({
      client: createGitlabClient({
        url: "https://gitlab.example.com",
        token: "t",
        transport: spy.transport,
      }),
      config: gitlabConfig({ groups: ["missing", "other"] }),
    });

    expect(repos.map((r) => r.name)).toEqual(["kept"]);
  });
});
