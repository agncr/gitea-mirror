import { describe, expect, test } from "bun:test";
import {
  organizationIdentityFilter,
  organizationRepositoriesFilter,
} from "./org-scope";

/**
 * Collect the column names a Drizzle condition tree references, so a missing
 * WHERE term is a test failure rather than a silent cross-provider or
 * cross-user query.
 */
function referencedColumns(node: any, acc: string[] = []): string[] {
  if (!node || typeof node !== "object") return acc;
  if (typeof node.name === "string" && node.table) acc.push(node.name);
  const chunks = node.queryChunks ?? node.chunks ?? null;
  if (Array.isArray(chunks)) chunks.forEach((c) => referencedColumns(c, acc));
  if (Array.isArray(node)) node.forEach((c) => referencedColumns(c, acc));
  return acc;
}

describe("organizationRepositoriesFilter", () => {
  const columns = () =>
    referencedColumns(
      organizationRepositoriesFilter({
        userId: "u1",
        organizationName: "acme",
        provider: "github",
      }),
    );

  test("scopes by user, so one user's mirror job cannot touch another's rows", () => {
    expect(columns()).toContain("user_id");
  });

  test("scopes by provider, so deleting GitHub acme spares GitLab acme", () => {
    expect(columns()).toContain("provider");
  });

  test("scopes by organization name", () => {
    expect(columns()).toContain("organization");
  });

  test("applies the same scoping for every provider", () => {
    for (const provider of ["github", "gitlab"] as const) {
      const cols = referencedColumns(
        organizationRepositoriesFilter({
          userId: "u1",
          organizationName: "acme",
          provider,
        }),
      );
      expect(cols).toContain("provider");
      expect(cols).toContain("user_id");
    }
  });
});

describe("organizationIdentityFilter", () => {
  const columns = () =>
    referencedColumns(
      organizationIdentityFilter({ userId: "u1", name: "acme", provider: "gitlab" }),
    );

  test("matches the unique index: user, provider and name", () => {
    const cols = columns();
    expect(cols).toContain("user_id");
    expect(cols).toContain("provider");
    expect(cols).toContain("name");
  });
});
