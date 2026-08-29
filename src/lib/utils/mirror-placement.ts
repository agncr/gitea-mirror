import type { Config } from "@/types/config";
import type { RepoProvider } from "@/lib/db/schema";

export type MirrorStrategy = "preserve" | "single-org" | "flat-user" | "mixed";
export type StarredPlacementMode = "dedicated-org" | "preserve-owner";

export interface MirrorPlacementSettings {
  mirrorStrategy: MirrorStrategy;
  starredReposMode: StarredPlacementMode;
  starredReposOrg: string;
  /**
   * The account name configured for the repository's source. Used by the
   * "preserve" strategy to tell "my own personal repo" (goes to defaultOwner)
   * apart from "someone else's personal repo" (keeps its source namespace).
   * Empty when the source has no configured account.
   */
  sourceOwner: string;
}

/**
 * Destination placement settings, which are GLOBAL across sources.
 *
 * These live in `githubConfig` for historical reasons — that column predates
 * multi-source support and is NOT NULL, so the fields are always readable even
 * for a GitLab-only setup. They describe where mirrors land in Gitea, not
 * anything about GitHub, and deliberately were not duplicated per source:
 * one user wants one destination layout, not two competing ones.
 *
 * `sourceOwner` is the only per-provider part, since each source has its own
 * account name.
 */
export function getMirrorPlacementSettings(
  config: Partial<Config>,
  provider: RepoProvider = "github",
): MirrorPlacementSettings {
  const githubConfig = config.githubConfig as
    | (NonNullable<Config["githubConfig"]> & { owner?: string; username?: string })
    | undefined;

  const mirrorStrategy =
    (githubConfig?.mirrorStrategy as MirrorStrategy | undefined) ??
    // Pre-strategy configs only had this boolean.
    (config.giteaConfig?.preserveOrgStructure ? "preserve" : "flat-user");

  const sourceOwner =
    provider === "gitlab"
      ? (config.gitlabConfig?.username ?? "")
      : (githubConfig?.owner || githubConfig?.username || "");

  return {
    mirrorStrategy,
    starredReposMode:
      (githubConfig?.starredReposMode as StarredPlacementMode | undefined) ??
      "dedicated-org",
    starredReposOrg: githubConfig?.starredReposOrg || "starred",
    sourceOwner: sourceOwner.trim().toLowerCase(),
  };
}
