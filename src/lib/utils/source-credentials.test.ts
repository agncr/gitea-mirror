import { describe, expect, test } from "bun:test";
import {
  missingProviderCredentials,
  requiredProvidersFor,
} from "./source-credentials";

describe("requiredProvidersFor", () => {
  test("treats rows without a provider as GitHub", () => {
    // Rows written before GitLab support have no provider.
    expect(requiredProvidersFor([{}, { provider: null }])).toEqual(["github"]);
  });

  test("reports both forges for a mixed batch", () => {
    const providers = requiredProvidersFor([
      { provider: "github" },
      { provider: "gitlab" },
      { provider: "github" },
    ]);
    expect(new Set(providers)).toEqual(new Set(["github", "gitlab"]));
  });

  test("returns nothing for an empty batch", () => {
    expect(requiredProvidersFor([])).toEqual([]);
  });
});

describe("missingProviderCredentials", () => {
  test("rejects a GitLab repository when only GitHub is configured", () => {
    // The failure this prevents: the endpoint reports success and the job then
    // dies asynchronously, with no token to mirror a private project.
    expect(
      missingProviderCredentials([{ provider: "gitlab" }], ["github"]),
    ).toEqual(["gitlab"]);
  });

  test("rejects a GitHub repository when only GitLab is configured", () => {
    expect(
      missingProviderCredentials([{ provider: "github" }], ["gitlab"]),
    ).toEqual(["github"]);
  });

  test("accepts a mixed batch when both sources are configured", () => {
    expect(
      missingProviderCredentials(
        [{ provider: "github" }, { provider: "gitlab" }],
        ["github", "gitlab"],
      ),
    ).toEqual([]);
  });

  test("accepts a GitHub-only batch on a GitHub-only configuration", () => {
    expect(missingProviderCredentials([{ provider: "github" }], ["github"])).toEqual(
      [],
    );
  });
});
