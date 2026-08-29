import type { RepoProvider } from "@/lib/db/schema";

/**
 * Presentation details for the forge a row came from.
 *
 * Rows created before GitLab support have no provider, so an absent value is
 * treated as GitHub everywhere in the UI.
 */
export function sourceProviderOf(value?: string | null): RepoProvider {
  return value === "gitlab" ? "gitlab" : "github";
}

export function sourceProviderLabel(value?: string | null): string {
  return sourceProviderOf(value) === "gitlab" ? "GitLab" : "GitHub";
}

/**
 * The link to an organization on its source forge.
 *
 * GitHub org names map straight onto a URL. GitLab group names are stored
 * FLATTENED ("acme-platform" for the group "acme/platform") because Gitea has
 * no nested organizations, and that flattened form is not a valid GitLab path —
 * so there is no honest URL to build, and callers should render no link rather
 * than a broken one.
 */
export function organizationSourceUrl(
  orgName: string,
  provider?: string | null,
): string | null {
  if (sourceProviderOf(provider) === "gitlab") {
    return null;
  }
  return `https://github.com/${orgName}`;
}
