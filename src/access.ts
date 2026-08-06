/**
 * Who is allowed to reach what.
 *
 * Without an `accessToken` this module does nothing at all and the server behaves exactly
 * as it always has: open to anyone who can reach the port. With one set, two rules apply.
 *
 * The first is that remote clients must carry the token as the leading path segment. It
 * lives in the path rather than a query string because Stremio builds the catalog, meta
 * and stream URLs by substituting onto the manifest URL it was installed with, and drops
 * the query string doing so — a `?key=` would authenticate the manifest and nothing after
 * it. The prefix is stripped before routing, so every route below this file, and the
 * relative URLs inside the HLS playlists, are unaware the token exists.
 *
 * The second is that the editor and diagnostics — `/api`, `/debug`, `/ui` — are not
 * reachable remotely under any token. They are the destructive surface, and a single
 * secret shared with a media player is the wrong thing guarding them.
 *
 * Deciding what counts as remote is the delicate part; see `isLocal`.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { FastifyReply, FastifyRequest, onRequestHookHandler } from "fastify";
import type { Config } from "./config.ts";
import { ClientRateLimiter, clientKey } from "./request-limits.ts";

/**
 * Paths a remote client may reach once it has presented the token. An allowlist rather
 * than a list of blocked prefixes, so that a route added later is private until somebody
 * deliberately publishes it.
 */
const REMOTE_EXACT = new Set([
  "/manifest.json",
  "/health",
  "/guide",
  "/watch",
  "/viewer/guide.json",
  "/watch/manifest.webmanifest",
]);
const REMOTE_PREFIXES = [
  "/catalog/",
  "/meta/",
  "/stream/",
  "/ch/",
  "/watch/",
  "/viewer/tune/",
];
const REMOTE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Host header values that identify the machine the server runs on. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);

/**
 * Headers no client can set for itself through a reverse proxy, because the proxy
 * overwrites or appends to them. Their presence means the request was relayed, which is
 * what disqualifies it from being treated as local — see `isLocal`.
 */
const FORWARDED_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-real-ip",
  "forwarded",
  "cf-connecting-ip",
  "cf-ray",
];

/** Set on the raw request by `rewriteUrl` and read back by the guard a moment later. */
const TOKEN_PRESENTED = Symbol("stremio-channels.tokenPresented");
const AUTH_LIMITED = Symbol("stremio-channels.authLimited");

type MarkedRequest = IncomingMessage & {
  [TOKEN_PRESENTED]?: boolean;
  [AUTH_LIMITED]?: boolean;
};

export interface AccessControl {
  /**
   * Passed to Fastify's constructor. Undefined when no token is configured, which keeps
   * the pre-routing hook out of the request path entirely.
   */
  rewriteUrl?: (req: IncomingMessage) => string;
  /** Registered as the first `onRequest` hook. */
  guard: onRequestHookHandler;
  /** Limits remote requests that can allocate playback or trigger resolution work. */
  throttle: onRequestHookHandler;
  /** Whether a path should carry the permissive CORS headers. */
  corsAllowed: (url: string) => boolean;
  /** True only for loopback or an explicitly trusted, unproxied request. */
  isLocalRequest: (req: FastifyRequest) => boolean;
}

/** The path segment carrying the token, or "" when there is none. */
export function urlPrefix(config: Config): string {
  return config.accessToken ? `/${config.accessToken}` : "";
}

/**
 * Replaces the token with a placeholder. Diagnostic output is meant to be pasted into bug
 * reports, and the stream URL it echoes now carries the secret.
 */
export function redactToken(config: Config, text: string): string {
  if (!config.accessToken) return text;
  return text.split(config.accessToken).join("<token>");
}

export function createAccessControl(config: Config): AccessControl {
  const token = config.accessToken;
  const trusted = new Set(config.trustedHosts.map((host) => host.trim().toLowerCase()));
  const authFailures = new ClientRateLimiter(
    config.authFailureLimit,
    config.authFailureWindowSeconds * 1000,
    config.authBlockSeconds * 1000,
  );
  const tuneRequests = new ClientRateLimiter(
    config.tuneRequestLimitPerMinute,
    60_000,
    60_000,
  );

  const throttle: onRequestHookHandler = async (req, reply) => {
    if (isLocal(req.raw, trusted) || !expensiveRemotePath(req.url)) return;
    const result = tuneRequests.hit(clientKey(req.raw));
    if (result.allowed) return;
    return reply
      .code(429)
      .header("Retry-After", String(result.retryAfterSeconds))
      .header("Cache-Control", "no-store")
      .send({ error: "too many tune requests" });
  };

  if (!token) {
    return {
      rewriteUrl: undefined,
      guard: async () => {},
      throttle,
      corsAllowed,
      isLocalRequest: (req) => isLocal(req.raw, trusted),
    };
  }

  // Hashing both sides before comparing sidesteps timingSafeEqual's requirement that its
  // arguments be the same length: digests always are, and a length mismatch would
  // otherwise have to be reported by throwing, which leaks the token's length.
  const expected = createHash("sha256").update(token).digest();

  return {
    rewriteUrl(req) {
      try {
        const { url, matched } = stripToken(req.url ?? "/", expected);
        if (matched) {
          (req as MarkedRequest)[TOKEN_PRESENTED] = true;
          authFailures.reset(clientKey(req));
        } else if (!isLocal(req, trusted)) {
          const result = authFailures.hit(clientKey(req));
          if (!result.allowed) (req as MarkedRequest)[AUTH_LIMITED] = true;
        }
        return url;
      } catch {
        // rewriteUrl must return a string or Fastify destroys the socket, so a bug here
        // has to degrade into "no token was presented" rather than a dropped connection.
        return req.url ?? "/";
      }
    },

    async guard(req: FastifyRequest, reply: FastifyReply) {
      if (isLocal(req.raw, trusted)) return;
      if ((req.raw as MarkedRequest)[TOKEN_PRESENTED] !== true) {
        if ((req.raw as MarkedRequest)[AUTH_LIMITED]) {
          // Make sustained guessing pay a connection and latency cost while preserving
          // the same opaque 404 response as an ordinary miss.
          await new Promise((resolve) => setTimeout(resolve, 250));
          reply.header("Connection", "close");
        }
        return deny(reply);
      }
      if (!REMOTE_METHODS.has(req.method) || !remoteAllowed(req.url)) return deny(reply);
    },

    throttle,
    corsAllowed,
    isLocalRequest: (req) => isLocal(req.raw, trusted),
  };
}

/**
 * A plain 404, never a 401 or 403: an unauthenticated caller should not be able to tell
 * a wrong token from a path that was never served, nor learn that this host runs
 * anything in particular.
 */
function deny(reply: FastifyReply): FastifyReply {
  reply.code(404).type("text/plain").send("not found");
  return reply;
}

/**
 * Is this request coming from the machine the server runs on, or a host the operator has
 * named?
 *
 * The Host header alone cannot answer this. Tailscale Funnel routes on the TLS SNI and
 * relays whatever Host the client sent, so `curl -H 'Host: 127.0.0.1' https://box.ts.net/`
 * would otherwise arrive looking local and be handed the editor API. Three things must
 * therefore agree, and anything unrecognised is remote:
 *
 *   1. the Host names loopback or an explicitly trusted host,
 *   2. no proxy has annotated the request,
 *   3. the connection itself came from loopback — unless the Host was one the operator
 *      trusted, which is the whole point of naming a LAN or tailnet address.
 *
 * Rule 2 is what a spoofer cannot satisfy, because the proxy in front of them adds those
 * headers unconditionally. A genuinely local client that sets one only demotes itself,
 * which is the harmless direction to fail in. Rule 3 additionally closes DNS rebinding,
 * where a hostile page resolves its own domain to 127.0.0.1 to reach this port.
 */
function isLocal(req: IncomingMessage, trusted: Set<string>): boolean {
  const rawHost = (req.headers.host ?? "").toLowerCase();
  const isTrusted = trusted.has(rawHost) || trusted.has(hostname(rawHost));
  if (!isTrusted && !LOOPBACK_HOSTS.has(hostname(rawHost))) return false;

  for (const header of FORWARDED_HEADERS) if (req.headers[header] !== undefined) return false;
  for (const header of Object.keys(req.headers)) if (header.startsWith("tailscale-")) return false;

  return isTrusted || isLoopbackAddress(req.socket.remoteAddress);
}

/** Host header minus its port. IPv6 literals arrive bracketed, per RFC 3986. */
function hostname(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host.slice(1) : host.slice(1, end);
  }
  const colon = host.indexOf(":");
  return colon === -1 ? host : host.slice(0, colon);
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  // Node reports IPv4 connections on a dual-stack socket in the ::ffff: form.
  const bare = address.startsWith("::ffff:") ? address.slice(7) : address;
  return bare === "::1" || bare.startsWith("127.");
}

/**
 * Removes a leading `/<token>` when it matches, reporting whether it did. Total by
 * construction: every branch returns, because Fastify calls this before routing and a
 * throw here would destroy the connection rather than produce an error response.
 */
function stripToken(url: string, expected: Buffer): { url: string; matched: boolean } {
  const segment = /^\/([^/?#]+)/.exec(url);
  const candidate = segment?.[1];
  if (!segment || candidate === undefined || !matches(candidate, expected)) {
    return { url, matched: false };
  }

  const rest = url.slice(segment[0].length);
  if (rest === "") return { url: "/", matched: true };
  // `/<token>?x=1` has to become `/?x=1`, not `?x=1`.
  return { url: rest.startsWith("/") ? rest : `/${rest}`, matched: true };
}

function matches(candidate: string, expected: Buffer): boolean {
  return timingSafeEqual(createHash("sha256").update(candidate).digest(), expected);
}

function remoteAllowed(url: string): boolean {
  const path = pathOf(url);
  if (REMOTE_EXACT.has(path)) return true;
  return REMOTE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function expensiveRemotePath(url: string): boolean {
  const path = pathOf(url);
  return path.startsWith("/stream/") || path.startsWith("/viewer/tune/") ||
    /^\/ch\/[^/]+\/live\.m3u8$/.test(path);
}

/**
 * `Access-Control-Allow-Origin: *` exists for Stremio's web client, which calls the addon
 * from another origin. Applying it to the editor API as well means any page the operator
 * visits can quietly POST to the server on localhost and rewrite their channel list, so
 * the headers are limited to the paths that actually need them. This holds whether or not
 * a token is configured — the browser is inside the network either way.
 */
function corsAllowed(url: string): boolean {
  return remoteAllowed(url);
}

function pathOf(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}
