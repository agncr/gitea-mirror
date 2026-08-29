import { and, eq } from "drizzle-orm";
// Imported from the schema module rather than "@/lib/db" on purpose: several
// test suites install a process-wide mock.module("@/lib/db") that replaces the
// table objects, which would strip the column metadata these filters are built
// from. Both modules export the same objects at runtime.
import { organizations, repositories, type RepoProvider } from "@/lib/db/schema";

/**
 * Rows for one organization ON ONE FORGE, belonging to ONE user.
 *
 * Every term matters:
 * - `userId` keeps one user's job from touching another user's rows when both
 *   imported an organization of the same name.
 * - `provider` keeps GitHub `acme` and GitLab `acme` apart. Since migration
 *   0015 those are two distinct organizations, so a query missing this term
 *   silently spans both — which for a DELETE means destroying the other
 *   forge's repositories.
 */
export function organizationRepositoriesFilter({
  userId,
  organizationName,
  provider,
}: {
  userId: string;
  organizationName: string;
  provider: RepoProvider;
}) {
  return and(
    eq(repositories.userId, userId),
    eq(repositories.provider, provider),
    eq(repositories.organization, organizationName),
  );
}

/**
 * The identity of a single organization row: `(userId, provider, name)`, which
 * is what the unique index enforces since migration 0015.
 *
 * Lookups that omit `provider` and then `.limit(1)` return whichever row the
 * database happens to yield first, so a GitLab group could pick up a GitHub
 * organization's destination override.
 */
export function organizationIdentityFilter({
  userId,
  name,
  provider,
}: {
  userId: string;
  name: string;
  provider: RepoProvider;
}) {
  return and(
    eq(organizations.userId, userId),
    eq(organizations.provider, provider),
    eq(organizations.name, name),
  );
}
