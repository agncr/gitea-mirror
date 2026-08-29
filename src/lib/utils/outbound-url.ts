/**
 * Validation for URLs that the SERVER will fetch on a caller's behalf
 * (the GitLab and Gitea connection tests, and the instance URLs stored in a
 * config that the scheduler later polls).
 *
 * Without this, an endpoint that takes a URL and requests it is an SSRF
 * primitive: the caller reaches anything the server can reach — cloud metadata
 * endpoints, admin panels on localhost, hosts inside the private network — and
 * distinguishable errors let them map what is there.
 *
 * Blocking literal private addresses does NOT stop an attacker who controls
 * DNS (a hostname resolving to 127.0.0.1, or rebinding between our check and
 * the request). Closing that requires resolving and pinning the address at
 * connection time. This is a deliberate first layer: it stops the trivial
 * cases and, combined with requiring authentication on these routes, takes the
 * endpoint out of the unauthenticated-attacker surface.
 */

export interface OutboundUrlPolicy {
  /**
   * Allow loopback/private/link-local targets. Necessary in practice: Gitea
   * commonly runs at http://gitea:3000 or on a private LAN address, and
   * self-hosted GitLab often does too.
   *
   * Defaults to the ALLOW_PRIVATE_SOURCE_URLS environment variable, so an
   * operator exposing this instance publicly can turn it off.
   */
  allowPrivateTargets?: boolean;
}

export type OutboundUrlResult =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

/** Hostnames that always point back at the machine itself. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

function isPrivateIPv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;

  const octets = parts.map((p) => Number(p));
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return false;

  const [a, b] = octets;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 0) return true; // "this network"
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  return false;
}

function isPrivateIPv6(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "::1" || host === "::") return true;
  if (host.startsWith("fc") || host.startsWith("fd")) return true; // unique local
  if (host.startsWith("fe80")) return true; // link-local
  return false;
}

/**
 * True when the host is an address literal that never leaves the local network.
 * Hostnames are not resolved here — see the module note on DNS.
 */
export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (LOOPBACK_HOSTNAMES.has(host)) return true;
  if (host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (isPrivateIPv4(host)) return true;
  if (host.includes(":") && isPrivateIPv6(host)) return true;
  return false;
}

function privateTargetsAllowedByDefault(): boolean {
  const raw = process.env.ALLOW_PRIVATE_SOURCE_URLS?.trim().toLowerCase();
  // Default true: self-hosted Gitea/GitLab on a private address is the normal
  // deployment, and defaulting to false would break existing installations.
  if (raw === "false" || raw === "0" || raw === "no") return false;
  return true;
}

/**
 * Validate a user-supplied instance URL before the server requests it.
 *
 * Returns the parsed URL on success, or a reason suitable for showing to the
 * (authenticated) caller.
 */
export function validateOutboundUrl(
  rawUrl: string,
  policy: OutboundUrlPolicy = {},
): OutboundUrlResult {
  const trimmed = (rawUrl ?? "").trim();
  if (!trimmed) {
    return { ok: false, reason: "URL is required" };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "URL is not valid" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    // Blocks file:, gopher:, and anything else that turns a fetch into a very
    // different operation.
    return { ok: false, reason: "Only http and https URLs are supported" };
  }

  if (url.username || url.password) {
    // Credentials in the URL would be forwarded to whatever the host resolves
    // to, and they hide the real target from a casual reader.
    return { ok: false, reason: "URL must not contain credentials" };
  }

  if (url.hash) {
    return { ok: false, reason: "URL must not contain a fragment" };
  }

  if (!url.hostname) {
    return { ok: false, reason: "URL must contain a host" };
  }

  const allowPrivate = policy.allowPrivateTargets ?? privateTargetsAllowedByDefault();
  if (!allowPrivate && isPrivateHostname(url.hostname)) {
    return {
      ok: false,
      reason:
        "URL points at a loopback, private or link-local address, which is not allowed on this instance",
    };
  }

  return { ok: true, url };
}
