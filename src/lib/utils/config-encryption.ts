import { decrypt } from "./encryption";
import type { Config } from "@/types/config";

/**
 * Decrypts tokens in a config object for use in API calls
 * @param config The config object with potentially encrypted tokens
 * @returns Config object with decrypted tokens
 */
export function decryptConfigTokens(config: Config): Config {
  const decryptedConfig = { ...config };
  
  // Deep clone the config objects
  if (config.githubConfig) {
    decryptedConfig.githubConfig = { ...config.githubConfig };
    if (config.githubConfig.token) {
      decryptedConfig.githubConfig.token = decrypt(config.githubConfig.token);
    }
  }
  
  if (config.gitlabConfig) {
    decryptedConfig.gitlabConfig = { ...config.gitlabConfig };
    if (config.gitlabConfig.token) {
      decryptedConfig.gitlabConfig.token = decrypt(config.gitlabConfig.token);
    }
  }

  if (config.giteaConfig) {
    decryptedConfig.giteaConfig = { ...config.giteaConfig };
    if (config.giteaConfig.token) {
      decryptedConfig.giteaConfig.token = decrypt(config.giteaConfig.token);
    }
  }

  return decryptedConfig;
}

/**
 * Gets a decrypted GitHub token from config
 * @param config The config object
 * @returns Decrypted GitHub token
 */
export function getDecryptedGitHubToken(config: Config): string {
  if (!config.githubConfig?.token) {
    throw new Error("GitHub token not found in config");
  }
  return decrypt(config.githubConfig.token);
}

/**
 * Gets a decrypted GitLab token from config
 * @param config The config object
 * @returns Decrypted GitLab token
 */
export function getDecryptedGitLabToken(config: Config): string {
  if (!config.gitlabConfig?.token) {
    throw new Error("GitLab token not found in config");
  }
  return decrypt(config.gitlabConfig.token);
}

/**
 * Whether a GitLab source is usable: a token and an instance URL are both set.
 */
export function hasGitLabSource(config: Config): boolean {
  // Trimmed: a whitespace-only token is not a usable credential.
  return Boolean(config.gitlabConfig?.token?.trim() && config.gitlabConfig?.url?.trim());
}

/**
 * Whether a GitHub source is usable.
 */
export function hasGitHubSource(config: Config): boolean {
  return Boolean(config.githubConfig?.token?.trim());
}

/**
 * Which forges this config can actually talk to, in a stable order.
 *
 * Every multi-source loop (import, scheduled sync, orphan cleanup) iterates
 * this rather than assuming GitHub, so a GitLab-only user is served and a
 * GitHub-only user behaves exactly as before.
 */
export function configuredSourceProviders(config: Config): ("github" | "gitlab")[] {
  const providers: ("github" | "gitlab")[] = [];
  if (hasGitHubSource(config)) providers.push("github");
  if (hasGitLabSource(config)) providers.push("gitlab");
  return providers;
}

/**
 * Gets a decrypted Gitea token from config
 * @param config The config object
 * @returns Decrypted Gitea token
 */
export function getDecryptedGiteaToken(config: Config): string {
  if (!config.giteaConfig?.token) {
    throw new Error("Gitea token not found in config");
  }
  return decrypt(config.giteaConfig.token);
}