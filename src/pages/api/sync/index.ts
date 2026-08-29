import type { APIRoute } from "astro";
import { db, organizations, repositories, configs } from "@/lib/db";
import { eq, and, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { createMirrorJob } from "@/lib/helpers";
import {
  createGitHubClient,
  getGithubOrganizations,
  getGithubRepositories,
  getGithubStarredRepositories,
} from "@/lib/github";
import { jsonResponse, createSecureErrorResponse } from "@/lib/utils";
import { mergeGitReposPreferStarred, calcBatchSizeForInsert } from "@/lib/repo-utils";
import {
  getDecryptedGitHubToken,
  getDecryptedGitLabToken,
  configuredSourceProviders,
} from "@/lib/utils/config-encryption";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";
import { isMirrorableGitHubRepo } from "@/lib/repo-eligibility";
import {
  createGitlabClient,
  getGitlabGroups,
  getGitlabRepositories,
  testGitlabConnection,
} from "@/lib/gitlab";
import type { GitRepo } from "@/types/Repository";
import type { GitOrg } from "@/types/organizations";
import type { RepoProvider } from "@/lib/db/schema";

interface SourceImport {
  repos: GitRepo[];
  orgs: GitOrg[];
  /**
   * Organizations/groups the source could not read. Each carries its own
   * provider: merging the lists across sources and stamping one provider onto
   * all of them would file an unreachable GitLab group as a GitHub
   * organization, where it can collide with a real one and never recover.
   */
  failedOrgs: { name: string; avatarUrl: string; reason: string; provider: RepoProvider }[];
  /** Repos the source exposes but that cannot be mirrored (disabled on GitHub). */
  skippedCount: number;
}

async function importFromGithub(
  config: any,
  userId: string,
  /** Normalized names of ignored GitHub organizations only. */
  ignoredGithubOrgNames: Set<string>,
): Promise<SourceImport> {
  const decryptedToken = getDecryptedGitHubToken(config);
  const githubUsername = config.githubConfig?.owner || undefined;
  const octokit = createGitHubClient(decryptedToken, userId, githubUsername);

  const [basicAndForkedRepos, starredRepos, orgResult] = await Promise.all([
    getGithubRepositories({ octokit, config }),
    config.githubConfig?.includeStarred
      ? getGithubStarredRepositories({ octokit, config })
      : Promise.resolve([]),
    getGithubOrganizations({ octokit, config, skipOrgNames: ignoredGithubOrgNames }),
  ]);

  // Merge and de-duplicate by fullName, preferring starred variant when duplicated
  const allRepos = mergeGitReposPreferStarred(basicAndForkedRepos, starredRepos);
  const mirrorable = allRepos.filter(isMirrorableGitHubRepo);

  return {
    repos: mirrorable,
    orgs: orgResult.organizations,
    failedOrgs: orgResult.failedOrgs.map((o) => ({ ...o, provider: "github" as const })),
    skippedCount: allRepos.length - mirrorable.length,
  };
}

async function importFromGitlab(config: any): Promise<SourceImport> {
  const client = createGitlabClient({
    url: config.gitlabConfig.url,
    token: getDecryptedGitLabToken(config),
  });

  const repos = await getGitlabRepositories({ client, config });

  // The account id is only needed to resolve group access levels; a failure
  // there costs a nicer membership badge, not the import.
  let currentUserId: number | undefined;
  try {
    const account = await testGitlabConnection({
      url: config.gitlabConfig.url,
      token: getDecryptedGitLabToken(config),
    });
    currentUserId = account.id;
  } catch {
    // Fall through with no id; roles default to "member".
  }

  const { organizations: orgs, failedGroups } = await getGitlabGroups({
    client,
    config,
    repositories: repos,
    currentUserId,
  });

  return {
    repos,
    orgs,
    failedOrgs: failedGroups.map((g) => ({ ...g, provider: "gitlab" as const })),
    skippedCount: 0,
  };
}

export const POST: APIRoute = async ({ request, locals }) => {
  const authResult = await requireAuthenticatedUserId({ request, locals });
  if ("response" in authResult) return authResult.response;
  const userId = authResult.userId;

  try {
    // Prefer active and most-recently-updated config to avoid picking a stale
    // inactive stub when multiple rows exist (see issue #271).
    const [config] = await db
      .select()
      .from(configs)
      .where(eq(configs.userId, userId))
      .orderBy(sql`${configs.isActive} DESC`, sql`${configs.updatedAt} DESC`)
      .limit(1);

    if (!config) {
      return jsonResponse({
        data: { error: "No configuration found for this user" },
        status: 404,
      });
    }

    const sourceProviders = configuredSourceProviders(config as any);
    if (sourceProviders.length === 0) {
      return jsonResponse({
        data: { error: "No source token is configured. Add a GitHub or GitLab token first." },
        status: 400,
      });
    }

    // Load ignored orgs from the DB so we can skip them during import
    const ignoredOrgRows = await db
      .select({
        normalizedName: organizations.normalizedName,
        provider: organizations.provider,
      })
      .from(organizations)
      .where(and(eq(organizations.userId, userId), eq(organizations.status, "ignored")));

    // Keyed by provider: ignoring GitHub "acme" must not also suppress an
    // unrelated GitLab group of the same name.
    const ignoredOrgKeys = new Set(
      ignoredOrgRows.map((o) => `${o.provider}:${o.normalizedName}`)
    );
    // getGithubOrganizations only ever sees GitHub organizations, so it takes
    // bare names — filtered to this provider so GitLab entries cannot leak in.
    const ignoredGithubOrgNames = new Set(
      ignoredOrgRows
        .filter((o) => o.provider === "github")
        .map((o) => o.normalizedName)
    );

    // Import every configured source. One failing source is reported but does
    // not discard what the others found.
    const sourceErrors: string[] = [];
    const imports: SourceImport[] = [];
    for (const provider of sourceProviders) {
      try {
        imports.push(
          provider === "gitlab"
            ? await importFromGitlab(config)
            : await importFromGithub(config, userId, ignoredGithubOrgNames)
        );
      } catch (sourceError) {
        const message = sourceError instanceof Error ? sourceError.message : String(sourceError);
        console.error(`[Sync] Failed to import from ${provider}: ${message}`);
        sourceErrors.push(`${provider}: ${message}`);
      }
    }

    if (imports.length === 0) {
      return jsonResponse({
        data: { error: `Import failed for every configured source. ${sourceErrors.join("; ")}` },
        status: 502,
      });
    }

    const discoveredRepos = imports.flatMap((i) => i.repos);
    const gitOrgs = imports.flatMap((i) => i.orgs);
    const failedOrgs = imports.flatMap((i) => i.failedOrgs);
    const skippedDisabledRepositories = imports.reduce((sum, i) => sum + i.skippedCount, 0);

    // Prepare full list of repos and orgs
    const newRepos = discoveredRepos.map((repo) => ({
      id: uuidv4(),
      userId,
      configId: config.id,
      name: repo.name,
      fullName: repo.fullName,
      normalizedFullName: repo.fullName.toLowerCase(),
      url: repo.url,
      cloneUrl: repo.cloneUrl,
      provider: repo.provider,
      owner: repo.owner,
      organization: repo.organization ?? null,
      mirroredLocation: repo.mirroredLocation || "",
      destinationOrg: repo.destinationOrg || null,
      isPrivate: repo.isPrivate,
      isForked: repo.isForked,
      forkedFrom: repo.forkedFrom ?? null,
      hasIssues: repo.hasIssues,
      isStarred: repo.isStarred,
      isArchived: repo.isArchived,
      size: repo.size,
      hasLFS: repo.hasLFS,
      hasSubmodules: repo.hasSubmodules,
      language: repo.language ?? null,
      description: repo.description ?? null,
      defaultBranch: repo.defaultBranch,
      visibility: repo.visibility,
      status: repo.status,
      lastMirrored: repo.lastMirrored ?? null,
      errorMessage: repo.errorMessage ?? null,
      importedAt: repo.importedAt,
      createdAt: repo.createdAt,
      updatedAt: repo.updatedAt,
    }));

    const newOrgs = gitOrgs.map((org) => ({
      id: uuidv4(),
      userId,
      configId: config.id,
      name: org.name,
      normalizedName: org.name.toLowerCase(),
      provider: org.provider,
      avatarUrl: org.avatarUrl,
      membershipRole: org.membershipRole,
      isIncluded: false,
      status: org.status,
      repositoryCount: org.repositoryCount,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    // Prepare failed org records for DB insertion
    const failedOrgRecords = failedOrgs.map((org) => ({
      id: uuidv4(),
      userId,
      configId: config.id,
      name: org.name,
      normalizedName: org.name.toLowerCase(),
      provider: org.provider,
      avatarUrl: org.avatarUrl,
      membershipRole: "member" as const,
      isIncluded: false,
      status: "failed" as const,
      errorMessage: org.reason,
      repositoryCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    let insertedRepos: typeof newRepos = [];
    let insertedOrgs: typeof newOrgs = [];
    let insertedFailedOrgs: typeof failedOrgRecords = [];
    let recoveredOrgCount = 0;

    // Transaction to insert only new items
    await db.transaction(async (tx) => {
      const [existingRepos, existingOrgs] = await Promise.all([
        tx
          .select({
            normalizedFullName: repositories.normalizedFullName,
            provider: repositories.provider,
          })
          .from(repositories)
          .where(eq(repositories.userId, userId)),
        tx
          .select({
            normalizedName: organizations.normalizedName,
            provider: organizations.provider,
            status: organizations.status,
          })
          .from(organizations)
          .where(eq(organizations.userId, userId)),
      ]);

      // Keyed by provider: the same path can legitimately exist on both forges.
      const existingRepoNames = new Set(
        existingRepos.map((r) => `${r.provider}:${r.normalizedFullName}`)
      );
      const existingOrgMap = new Map(
        existingOrgs.map((o) => [`${o.provider}:${o.normalizedName}`, o.status])
      );

      insertedRepos = newRepos.filter(
        (r) =>
          !existingRepoNames.has(`${r.provider}:${r.normalizedFullName}`) &&
          (!r.organization ||
            !ignoredOrgKeys.has(`${r.provider}:${r.organization.toLowerCase()}`))
      );
      insertedOrgs = newOrgs.filter(
        (o) => !existingOrgMap.has(`${o.provider}:${o.normalizedName}`)
      );

      // Update previously failed orgs that now succeeded
      const recoveredOrgs = newOrgs.filter(
        (o) => existingOrgMap.get(`${o.provider}:${o.normalizedName}`) === "failed"
      );
      for (const org of recoveredOrgs) {
        await tx
          .update(organizations)
          .set({
            status: "imported",
            errorMessage: null,
            repositoryCount: org.repositoryCount,
            avatarUrl: org.avatarUrl,
            membershipRole: org.membershipRole,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(organizations.userId, userId),
              eq(organizations.provider, org.provider),
              eq(organizations.normalizedName, org.normalizedName),
            )
          );
      }
      recoveredOrgCount = recoveredOrgs.length;

      // Insert or update failed orgs (only update orgs already in "failed" state — don't overwrite good state)
      insertedFailedOrgs = failedOrgRecords.filter(
        (o) => !existingOrgMap.has(`${o.provider}:${o.normalizedName}`)
      );
      const stillFailedOrgs = failedOrgRecords.filter(
        (o) => existingOrgMap.get(`${o.provider}:${o.normalizedName}`) === "failed"
      );
      for (const org of stillFailedOrgs) {
        await tx
          .update(organizations)
          .set({
            errorMessage: org.errorMessage,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(organizations.userId, userId),
              eq(organizations.provider, org.provider),
              eq(organizations.normalizedName, org.normalizedName),
            )
          );
      }

      // Batch insert repositories to avoid SQLite parameter limit (dynamic by column count)
      const sample = newRepos[0];
      const columnCount = Object.keys(sample ?? {}).length || 1;
      const REPO_BATCH_SIZE = calcBatchSizeForInsert(columnCount);
      if (insertedRepos.length > 0) {
        for (let i = 0; i < insertedRepos.length; i += REPO_BATCH_SIZE) {
          const batch = insertedRepos.slice(i, i + REPO_BATCH_SIZE);
          await tx
            .insert(repositories)
            .values(batch)
            .onConflictDoNothing({ target: [repositories.userId, repositories.provider, repositories.normalizedFullName] });
        }
      }

      // Batch insert organizations (they have fewer fields, so we can use larger batches)
      const ORG_BATCH_SIZE = 100;
      const allNewOrgs = [...insertedOrgs, ...insertedFailedOrgs];
      if (allNewOrgs.length > 0) {
        for (let i = 0; i < allNewOrgs.length; i += ORG_BATCH_SIZE) {
          const batch = allNewOrgs.slice(i, i + ORG_BATCH_SIZE);
          // Backstop: an unexpected duplicate must skip that row, not abort the
          // whole import transaction and lose every repository with it.
          await tx
            .insert(organizations)
            .values(batch)
            .onConflictDoNothing({
              target: [
                organizations.userId,
                organizations.provider,
                organizations.normalizedName,
              ],
            });
        }
      }
    });

    // Create mirror jobs only for newly inserted items
    const mirrorJobPromises = [
      ...insertedRepos.map((repo) =>
        createMirrorJob({
          userId,
          repositoryId: repo.id,
          repositoryName: repo.name,
          status: "imported",
          message: `Repository ${repo.name} fetched successfully`,
          details: `Repository ${repo.name} was fetched from ${repo.provider === "gitlab" ? "GitLab" : "GitHub"}`,
        })
      ),
      ...insertedOrgs.map((org) =>
        createMirrorJob({
          userId,
          organizationId: org.id,
          organizationName: org.name,
          status: "imported",
          message: `Organization ${org.name} fetched successfully`,
          details: `Organization ${org.name} was fetched from ${org.provider === "gitlab" ? "GitLab" : "GitHub"}`,
        })
      ),
    ];

    await Promise.all(mirrorJobPromises);

    return jsonResponse({
      data: {
        success: true,
        message: "Repositories and organizations synced successfully",
        newRepositories: insertedRepos.length,
        newOrganizations: insertedOrgs.length,
        skippedDisabledRepositories,
        failedOrgs: failedOrgs
          .filter((o) => !ignoredOrgKeys.has(`${o.provider}:${o.name.toLowerCase()}`))
          .map((o) => o.name),
        recoveredOrgs: recoveredOrgCount,
        // Present only when at least one source failed while another succeeded.
        ...(sourceErrors.length > 0 ? { sourceErrors } : {}),
      },
    });
  } catch (error) {
    return createSecureErrorResponse(error, "source data sync", 500);
  }
};
