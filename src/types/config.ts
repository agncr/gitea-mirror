import { type Config as ConfigType } from "@/lib/db/schema";

export type GiteaOrgVisibility = "public" | "private" | "limited";
export type MirrorStrategy = "preserve" | "single-org" | "flat-user" | "mixed";
export type StarredReposMode = "dedicated-org" | "preserve-owner";
export type BackupStrategy = "disabled" | "always" | "on-force-push" | "block-on-force-push";
export type ScheduleMode = "interval" | "clock";

export interface GiteaConfig {
  url: string;
  externalUrl?: string;
  username: string;
  token: string;
  organization: string;
  visibility: GiteaOrgVisibility;
  starredReposOrg: string;
  starredReposMode?: StarredReposMode;
  preserveOrgStructure: boolean;
  mirrorStrategy?: MirrorStrategy; // New field for the strategy
  personalReposOrg?: string; // Override destination for personal repos
  issueConcurrency?: number;
  pullRequestConcurrency?: number;
  backupStrategy?: BackupStrategy;
  backupBeforeSync?: boolean; // Deprecated: kept for backward compat, use backupStrategy
  backupRetentionCount?: number;
  backupRetentionDays?: number;
  backupDirectory?: string;
  blockSyncOnBackupFailure?: boolean;
}

export interface ScheduleConfig {
  enabled: boolean;
  interval: number | string;
  intervalExpression?: string;
  scheduleMode?: ScheduleMode;
  clockFrequencyHours?: number;
  startTime?: string;
  timezone?: string;
  autoMirror?: boolean;
  lastRun?: Date;
  nextRun?: Date;
}

export interface DatabaseCleanupConfig {
  enabled: boolean;
  retentionDays: number; // Actually stores seconds, but keeping the name for compatibility
  deleteIfNotInGitHub: boolean;
  orphanedRepoAction: "skip" | "archive" | "delete";
  dryRun: boolean;
  deleteFromGitea?: boolean;
  protectedRepos?: string[];
  batchSize?: number;
  pauseBetweenDeletes?: number;
  lastRun?: Date;
  nextRun?: Date;
}

export type DuplicateNameStrategy = "suffix" | "prefix" | "owner-org";

export interface GitHubConfig {
  username: string;
  token: string;
  privateRepositories: boolean;
  includeCollaboratorRepos?: boolean;
  includeOrganizations?: string[];
  mirrorStarred: boolean;
  starredLists?: string[];
  starredDuplicateStrategy?: DuplicateNameStrategy;
  starredReposMode?: StarredReposMode;
}

/**
 * GitLab source settings. Unlike {@link GitHubConfig}, the UI shape is identical
 * to the stored shape, so `config-mapper.ts` passes it through unrenamed.
 *
 * Destination placement (mirror strategy, default org, ...) is shared across all
 * sources and lives in the GitHub/Gitea config — see `getMirrorPlacementSettings`.
 */
export interface GitLabConfig {
  url: string;
  token: string;
  username?: string;
  /** Top-level group paths to mirror, e.g. ["acme", "acme/platform"]. */
  groups: string[];
  includeSubgroups: boolean;
  includeOwnProjects: boolean;
  includeForks: boolean;
  includeArchived: boolean;
  includePrivate: boolean;
  includePublic: boolean;
}

export interface MirrorOptions {
  mirrorReleases: boolean;
  releaseLimit?: number;  // Limit number of releases to mirror (default: 10)
  mirrorLFS: boolean;  // Mirror Git LFS objects
  mirrorMetadata: boolean;
  metadataComponents: {
    issues: boolean;
    pullRequests: boolean;
    labels: boolean;
    milestones: boolean;
    wiki: boolean;
  };
}

export interface AdvancedOptions {
  skipForks: boolean;
  starredCodeOnly: boolean;
  autoMirrorStarred?: boolean;
  skipPersonalRepos?: boolean;
}

export interface SaveConfigApiRequest {
  userId: string;
  githubConfig: GitHubConfig;
  /**
   * Optional. Omitting the key (or sending null) preserves whatever is stored,
   * so a client that predates GitLab support cannot wipe an env-provisioned
   * GitLab source by saving an unrelated section.
   */
  gitlabConfig?: GitLabConfig | null;
  giteaConfig: GiteaConfig;
  scheduleConfig: ScheduleConfig;
  cleanupConfig: DatabaseCleanupConfig;
  notificationConfig?: NotificationConfig;
  mirrorOptions?: MirrorOptions;
  advancedOptions?: AdvancedOptions;
}

export interface SaveConfigApiResponse {
  success: boolean;
  message: string;
}

export interface NtfyConfig {
  url: string;
  topic: string;
  token?: string;
  priority: "min" | "low" | "default" | "high" | "urgent";
}

export interface AppriseConfig {
  url: string;
  token: string;
  tag?: string;
}

export interface GotifyConfig {
  url: string;
  token: string;
  priority: number;
}

export interface WebhookConfig {
  url: string;
  secret?: string;
}

export interface NotificationConfig {
  enabled: boolean;
  provider: "ntfy" | "apprise" | "gotify" | "webhook";
  notifyOnSyncError: boolean;
  notifyOnSyncSuccess: boolean;
  notifyOnNewRepo: boolean;
  ntfy?: NtfyConfig;
  apprise?: AppriseConfig;
  gotify?: GotifyConfig;
  webhook?: WebhookConfig;
}

export interface Config extends ConfigType {}

export interface ConfigApiRequest {
  userId: string;
}

export interface ConfigApiResponse {
  id: string;
  userId: string;
  name: string;
  isActive: boolean;
  githubConfig: GitHubConfig;
  gitlabConfig?: GitLabConfig | null;
  giteaConfig: GiteaConfig;
  scheduleConfig: ScheduleConfig;
  cleanupConfig: DatabaseCleanupConfig;
  notificationConfig?: NotificationConfig;
  mirrorOptions?: MirrorOptions;
  advancedOptions?: AdvancedOptions;
  include: string[];
  exclude: string[];
  createdAt: Date;
  updatedAt: Date;
  error?: string;
}
