import type { RepoProvider } from "@/lib/db/schema";

/**
 * Which forges a set of rows actually needs credentials for.
 *
 * Checking merely that "some source is configured" is not enough: a private
 * GitLab project scheduled with only a GitHub token would be accepted by the
 * endpoint and then fail inside the asynchronous job, long after the caller was
 * told the work had started.
 */
export function requiredProvidersFor(
  rows: ReadonlyArray<{ provider?: string | null }>,
): RepoProvider[] {
  const providers = new Set<RepoProvider>();
  for (const row of rows) {
    providers.add(row.provider === "gitlab" ? "gitlab" : "github");
  }
  return [...providers];
}

/**
 * The providers a batch needs but the configuration cannot serve.
 * Empty means the job can be scheduled.
 */
export function missingProviderCredentials(
  rows: ReadonlyArray<{ provider?: string | null }>,
  availableProviders: ReadonlyArray<string>,
): RepoProvider[] {
  const available = new Set(availableProviders);
  return requiredProvidersFor(rows).filter((provider) => !available.has(provider));
}
