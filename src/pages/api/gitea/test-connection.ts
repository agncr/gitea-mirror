import type { APIRoute } from 'astro';
import { httpGet, HttpError } from '@/lib/http-client';
import { createSecureErrorResponse } from '@/lib/utils';
import { requireAuthenticatedUserId } from '@/lib/auth-guards';
import { validateOutboundUrl } from '@/lib/utils/outbound-url';

// Forgejo reports `15.0.0+gitea-1.22.0`; pure Gitea reports just `1.22.0`.
// Forgejo < 15.0.0 has a known bug where pull-mirror credentials sent via
// /api/v1/repos/migrate are not persisted, so subsequent sync of private
// repos fails with `terminal prompts disabled`. Fixed upstream in v15.0.0
// via PR #11909 (codeberg.org/forgejo/forgejo/pulls/11909).
function parseServerInfo(versionString: string) {
  const forgejoMatch = versionString.match(/^(\d+)\.(\d+)\.(\d+)\+gitea-/);
  if (forgejoMatch) {
    const major = Number(forgejoMatch[1]);
    return {
      type: 'forgejo' as const,
      version: `${forgejoMatch[1]}.${forgejoMatch[2]}.${forgejoMatch[3]}`,
      raw: versionString,
      hasMirrorCredBug: major < 15,
    };
  }
  return { type: 'gitea' as const, version: versionString, raw: versionString, hasMirrorCredBug: false };
}

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    // The server fetches a caller-supplied URL here, so authentication is
    // required: unauthenticated, this endpoint is an SSRF primitive.
    const authResult = await requireAuthenticatedUserId({ request, locals });
    if ("response" in authResult) return authResult.response;

    const body = await request.json();
    const { url, token, username } = body;

    if (!url || !token) {
      return new Response(
        JSON.stringify({
          success: false,
          message: 'Gitea URL and token are required',
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );
    }

    const urlCheck = validateOutboundUrl(url);
    if (!urlCheck.ok) {
      return new Response(
        JSON.stringify({ success: false, message: urlCheck.reason }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Normalize the URL (remove trailing slash if present)
    const baseUrl = url.endsWith('/') ? url.slice(0, -1) : url;

    // Test the connection by fetching the authenticated user
    const response = await httpGet(`${baseUrl}/api/v1/user`, {
      'Authorization': `token ${token}`,
      'Accept': 'application/json',
    });

    const data = response.data;

    // Verify that the authenticated user matches the provided username (if provided)
    if (username && data.login !== username) {
      return new Response(
        JSON.stringify({
          success: false,
          message: `Token belongs to ${data.login}, not ${username}`,
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );
    }

    let serverInfo: ReturnType<typeof parseServerInfo> | undefined;
    try {
      const versionResp = await httpGet(`${baseUrl}/api/v1/version`, {
        'Accept': 'application/json',
      });
      if (typeof versionResp.data?.version === 'string') {
        serverInfo = parseServerInfo(versionResp.data.version);
      }
    } catch {
      // Version probe is best-effort; older or non-standard servers may not expose it.
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `Successfully connected to Gitea as ${data.login}`,
        user: {
          login: data.login,
          name: data.full_name,
          avatar_url: data.avatar_url,
        },
        serverInfo,
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (error) {
    console.error('Gitea connection test failed:', error);

    // Handle specific error types
    if (error instanceof HttpError) {
      if (error.status === 401) {
        return new Response(
          JSON.stringify({
            success: false,
            message: 'Invalid Gitea token',
          }),
          {
            status: 401,
            headers: {
              'Content-Type': 'application/json',
            },
          }
        );
      } else if (error.status === 404) {
        return new Response(
          JSON.stringify({
            success: false,
            message: 'Gitea API endpoint not found. Please check the URL.',
          }),
          {
            status: 404,
            headers: {
              'Content-Type': 'application/json',
            },
          }
        );
      } else if (error.status === 0) {
        // Network error
        return new Response(
          JSON.stringify({
            success: false,
            message: 'Could not connect to Gitea server. Please check the URL.',
          }),
          {
            status: 500,
            headers: {
              'Content-Type': 'application/json',
            },
          }
        );
      }
    }

    // Generic error response
    return createSecureErrorResponse(error, "Gitea connection test", 500);
  }
};
