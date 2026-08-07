import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export const MAX_GUIDE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const REQUEST_TIMEOUT_MS = 15_000;

interface Address {
  address: string;
  family: 4 | 6;
}

export interface GuideFetchPolicy {
  /** Allows private/link-local destinations and plain HTTP for those destinations only. */
  allowPrivate: boolean;
}

/**
 * Fetch an untrusted guide without giving it access to the host's internal network.
 * Every redirect is resolved and checked, and the request is pinned to the checked IP so
 * a DNS rebinding answer cannot change between policy evaluation and connection time.
 */
export async function fetchGuideBundle(
  input: string,
  policy: GuideFetchPolicy,
): Promise<unknown> {
  let current = parseGuideUrl(input);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const addresses = await resolveAndValidate(current, policy);
    const response = await requestPinned(current, addresses[0]!);
    const status = response.statusCode ?? 0;

    if (isRedirect(status)) {
      response.destroy();
      if (redirects === MAX_REDIRECTS) throw new Error("guide URL redirected too many times");
      const location = response.headers.location;
      if (!location) throw new Error("guide URL returned a redirect without a location");
      current = parseGuideUrl(new URL(location, current).toString());
      continue;
    }

    if (status < 200 || status >= 300) {
      response.destroy();
      throw new Error(`guide URL returned ${status}`);
    }

    const declared = Number(response.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > MAX_GUIDE_BYTES) {
      response.destroy();
      throw new Error("guide is too large");
    }

    const text = await boundedText(response, MAX_GUIDE_BYTES);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("guide URL did not return JSON — link to the raw file, not a web page");
    }
  }

  throw new Error("guide URL redirected too many times");
}

function parseGuideUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("guide URL must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("guide URL must be http or https");
  }
  if (url.username || url.password) throw new Error("guide URL must not contain credentials");
  return url;
}

async function resolveAndValidate(url: URL, policy: GuideFetchPolicy): Promise<Address[]> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(hostname);
  let addresses: Address[];
  if (literalFamily === 4 || literalFamily === 6) {
    addresses = [{ address: hostname, family: literalFamily }];
  } else {
    if (/^(localhost|.*\.localhost)$/i.test(hostname) && !policy.allowPrivate) {
      throw new Error("guide URL points to a private or local address");
    }
    const resolved = await dnsLookup(hostname, { all: true, verbatim: true });
    addresses = resolved
      .filter((entry): entry is Address => entry.family === 4 || entry.family === 6)
      .map((entry) => ({ address: entry.address, family: entry.family }));
  }
  if (addresses.length === 0) throw new Error("guide URL hostname did not resolve");

  const hasPrivate = addresses.some((entry) => isNonPublicAddress(entry.address));
  if (hasPrivate && !policy.allowPrivate) {
    throw new Error("guide URL points to a private or local address");
  }
  // Public plaintext links let an on-path attacker replace the guide after preview.
  // Private HTTP is permitted only behind the operator's explicit LAN override.
  if (url.protocol !== "https:" && !hasPrivate) {
    throw new Error("public guide URLs must use https");
  }
  return addresses;
}

/** True for addresses that an untrusted URL must never be allowed to reach. */
export function isNonPublicAddress(input: string): boolean {
  const mapped = input.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (mapped) return isNonPublicAddress(mapped);

  if (isIP(input) === 4) {
    const octets = input.split(".").map(Number);
    const [a = 0, b = 0] = octets;
    return a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) ||
      a >= 224;
  }

  if (isIP(input) === 6) {
    const normalized = input.toLowerCase();
    return normalized === "::" || normalized === "::1" ||
      /^(fc|fd)/.test(normalized) ||
      /^(fe[89ab])/.test(normalized) ||
      normalized.startsWith("ff") ||
      normalized.startsWith("2001:db8:");
  }
  return true;
}

function requestPinned(url: URL, pinned: Address) {
  const makeRequest = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const req = makeRequest(url, {
      headers: {
        accept: "application/json, text/plain",
        "accept-encoding": "identity",
        "user-agent": "Headend-Guide-Importer/1",
      },
      lookup: (_hostname, _options, callback) => {
        callback(null, pinned.address, pinned.family);
      },
    }, resolve);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error("guide URL timed out")));
    req.once("error", reject);
    req.end();
  });
}

function isRedirect(status: number | undefined): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function boundedText(
  response: import("node:http").IncomingMessage,
  limit: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > limit) {
      response.destroy();
      throw new Error("guide is too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}
