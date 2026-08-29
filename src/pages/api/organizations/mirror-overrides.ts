import type { APIRoute } from "astro";
import { createSecureErrorResponse } from "@/lib/utils";
import { requireAuth } from "@/lib/utils/auth-helpers";
import { loadOrganizationMirrorOverrides } from "@/lib/utils/mirror-overrides";

/**
 * Look up one organization's mirror overrides by name.
 *
 * The repositories payload carries an organization *name*, not an id, so the
 * repository overrides dialog needs a name-keyed lookup to show what "Inherit"
 * actually resolves to (global -> org). Reuses the same loader the mirror paths
 * use, which scopes the query to the calling user.
 *
 * GET /api/organizations/mirror-overrides?name=<orgName>
 */
export const GET: APIRoute = async (context) => {
  try {
    const { user, response } = await requireAuth(context);
    if (response) return response;

    const name = context.url.searchParams.get("name")?.trim();
    if (!name) {
      return new Response(
        JSON.stringify({ error: "Organization name is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Defaults to github so links from clients that predate GitLab support
    // keep resolving to the organization they always meant.
    const provider =
      context.url.searchParams.get("provider") === "gitlab" ? "gitlab" : "github";

    // Returns null for unknown orgs, which the caller treats the same as
    // "no overrides" — the hint then falls back to the global values.
    const mirrorOverrides = await loadOrganizationMirrorOverrides({
      organizationName: name,
      userId: user!.id,
      provider,
    });

    return new Response(
      JSON.stringify({ success: true, name, provider, mirrorOverrides }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    return createSecureErrorResponse(
      error,
      "Load organization mirror overrides",
      500
    );
  }
};
