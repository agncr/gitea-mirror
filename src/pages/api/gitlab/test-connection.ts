import type { APIRoute } from "astro";
import { testGitlabConnection } from "@/lib/gitlab";
import { createSecureErrorResponse } from "@/lib/utils";
import { HttpError } from "@/lib/http-client";
import { requireAuthenticatedUserId } from "@/lib/auth-guards";
import { validateOutboundUrl } from "@/lib/utils/outbound-url";

export const POST: APIRoute = async ({ request, locals }) => {
  // Declared outside the try so the catch block can name the URL that failed.
  let instanceUrl = "https://gitlab.com";

  try {
    // This endpoint makes the server fetch a caller-supplied URL, so it must
    // not be reachable unauthenticated — otherwise it is an SSRF primitive.
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;

    const body = await request.json();
    const { token, url, username } = body;

    if (!token) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "GitLab token is required",
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    // Defaults to gitlab.com; self-hosted instances supply their own URL.
    instanceUrl = (url || "https://gitlab.com").trim();

    const urlCheck = validateOutboundUrl(instanceUrl);
    if (!urlCheck.ok) {
      return new Response(
        JSON.stringify({ success: false, message: urlCheck.reason }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const account = await testGitlabConnection({ url: instanceUrl, token });

    // Mirrors the GitHub route: a token belonging to a different account is
    // almost always a copy-paste mistake worth surfacing early.
    if (username && account.username !== username) {
      return new Response(
        JSON.stringify({
          success: false,
          message: `Token belongs to ${account.username}, not ${username}`,
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `Successfully connected to GitLab as ${account.username}`,
        user: {
          login: account.username,
          name: account.name,
          avatar_url: account.avatarUrl,
        },
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    console.error("GitLab connection test failed:", error);

    if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "Invalid GitLab token, or it lacks the read_api scope",
        }),
        {
          status: 401,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    // httpRequest reports unreachable hosts as status 0. Almost always a typo
    // in a self-hosted instance URL, so name that rather than returning a bare
    // internal error.
    if (error instanceof HttpError && error.status === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          message: `Could not reach ${instanceUrl}. Check the instance URL and that it is reachable from the server.`,
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    // A wrong instance URL surfaces as a 404 on /api/v4/user rather than an
    // auth error, so say so instead of blaming the token.
    if (error instanceof HttpError && error.status === 404) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "GitLab API not found at that URL. Check the instance URL.",
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    return createSecureErrorResponse(error, "GitLab connection test", 500);
  }
};
