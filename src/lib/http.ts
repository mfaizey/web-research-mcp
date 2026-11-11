import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { ErrorCodes, ResearchError } from "./errors.js";

const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const MAX_BYTES = 2 * 1024 * 1024;

const HTML_MEDIA_TYPES = new Set(["text/html", "application/xhtml+xml"]);

const REQUEST_HEADERS = {
  accept: "text/html, application/xhtml+xml",
  "user-agent": "web-research-mcp",
};

export type FetchedPage = {
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
};

// Kept for callers that only need the document and its location.
export type FetchedHtml = {
  url: string;
  contentType: string;
  body: string;
};

// Not globally routable: loopback, private, link-local, CGNAT, documentation,
// benchmarking, multicast, and other reserved ranges.
const reserved = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  reserved.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  reserved.addSubnet(network, prefix, "ipv6");
}

// Special-use names that should never reach the network.
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home", ".lan", ".test", ".invalid"];

function stripIpDecorations(address: string): string {
  const noBrackets =
    address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  const zone = noBrackets.indexOf("%");
  return zone === -1 ? noBrackets : noBrackets.slice(0, zone);
}

function normalizeHostname(hostname: string): string {
  const bare = stripIpDecorations(hostname).toLowerCase();
  return bare.endsWith(".") ? bare.slice(0, -1) : bare;
}

function isBlockedHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  return BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function expandIpv6(ip: string): string[] | undefined {
  const pieces = ip.split("::");
  if (pieces.length > 2) return undefined;

  const parseSide = (side: string): string[] | undefined => {
    if (side.length === 0) return [];
    const groups: string[] = [];
    for (const group of side.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return undefined;
      groups.push(group.padStart(4, "0").toLowerCase());
    }
    return groups;
  };

  const left = parseSide(pieces[0] ?? "");
  if (left === undefined) return undefined;
  if (pieces.length === 1) return left.length === 8 ? left : undefined;

  const right = parseSide(pieces[1] ?? "");
  if (right === undefined || left.length + right.length > 7) return undefined;
  const middle = Array<string>(8 - left.length - right.length).fill("0000");
  return [...left, ...middle, ...right];
}

function ipv4FromHex(hex: string): string | undefined {
  if (!/^[0-9a-f]{8}$/i.test(hex)) return undefined;
  const octets = [0, 2, 4, 6].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  return octets.join(".");
}

// 6to4, NAT64, and IPv4-mapped addresses can hide a private IPv4 target.
function embeddedIpv4(ip: string): string | undefined {
  const dottedTail = /^(.*):(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  const normalized =
    dottedTail?.[1] !== undefined && dottedTail[2] !== undefined && isIP(dottedTail[2]) === 4
      ? `${dottedTail[1]}:${dottedToHextets(dottedTail[2])}`
      : ip;

  const groups = expandIpv6(normalized);
  if (groups === undefined) return undefined;
  const hex = groups.join("");

  if (hex.startsWith("00000000000000000000ffff") || hex.startsWith("0064ff9b0000000000000000")) {
    return ipv4FromHex(hex.slice(24));
  }
  if (hex.startsWith("2002")) return ipv4FromHex(hex.slice(4, 12));
  return undefined;
}

function dottedToHextets(ipv4: string): string {
  const [a = 0, b = 0, c = 0, d = 0] = ipv4.split(".").map((part) => Number(part));
  return `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
}

function isBlockedAddress(address: string): boolean {
  const bare = stripIpDecorations(address);
  const version = isIP(bare);
  if (version === 4) return reserved.check(bare, "ipv4");
  if (version !== 6) return true;

  const embedded = embeddedIpv4(bare);
  if (embedded !== undefined && reserved.check(embedded, "ipv4")) return true;

  try {
    return reserved.check(bare, "ipv6");
  } catch {
    return true;
  }
}

function parseHttpUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ResearchError(ErrorCodes.InvalidUrl, "Not a valid URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ResearchError(ErrorCodes.InvalidUrl, "Only http and https URLs are allowed");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ResearchError(ErrorCodes.InvalidUrl, "URLs with credentials are not allowed");
  }
  if (url.hostname === "") {
    throw new ResearchError(ErrorCodes.InvalidUrl, "URL is missing a hostname");
  }
  return url;
}

/**
 * Synchronously reject URLs that can never be fetched safely. Hostnames that
 * are not IP literals still need a DNS check in safeFetch before connecting.
 */
export function assertSafeUrl(input: string): URL {
  const url = parseHttpUrl(input);
  const host = normalizeHostname(url.hostname);

  if (isIP(host) !== 0) {
    if (isBlockedAddress(host)) {
      throw new ResearchError(ErrorCodes.BlockedHost, `Blocked address ${host}`);
    }
    return url;
  }

  if (isBlockedHostname(host)) {
    throw new ResearchError(ErrorCodes.BlockedHost, `Blocked host ${host}`);
  }
  return url;
}

async function assertPublicHostname(hostname: string): Promise<void> {
  const host = normalizeHostname(hostname);
  if (isIP(host) !== 0) {
    if (isBlockedAddress(host)) {
      throw new ResearchError(ErrorCodes.BlockedHost, `Blocked address ${host}`);
    }
    return;
  }

  // DNS rebinding: resolve-then-fetch is not atomic. The name can point at a
  // public address here and a private one by the time fetch() connects.
  // Acceptable for a demo.
  let records: { address: string }[];
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new ResearchError(ErrorCodes.FetchFailed, `Could not resolve ${host}`);
  }

  if (records.length === 0) {
    throw new ResearchError(ErrorCodes.FetchFailed, `Could not resolve ${host}`);
  }
  if (records.some((record) => isBlockedAddress(record.address))) {
    throw new ResearchError(ErrorCodes.BlockedHost, `Blocked host ${host}`);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function mediaType(header: string | null): string | undefined {
  const value = header?.split(";", 1)[0]?.trim().toLowerCase();
  return value === undefined || value.length === 0 ? undefined : value;
}

function contentLength(header: string | null): number | undefined {
  if (header === null) return undefined;
  const value = Number(header);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function readAtMost(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";

  const chunks: Uint8Array[] = [];
  let received = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResearchError(ErrorCodes.TooLarge, `Response is larger than ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return new TextDecoder().decode(Buffer.concat(chunks));
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function redirectTarget(current: URL, location: string | null): string {
  if (location === null || location.trim() === "") {
    throw new ResearchError(ErrorCodes.HttpError, "Redirect is missing a Location header");
  }
  try {
    return new URL(location, current).href;
  } catch {
    throw new ResearchError(ErrorCodes.InvalidUrl, "Redirect Location is not a valid URL");
  }
}

async function readHtml(response: Response, url: URL): Promise<FetchedPage> {
  if (!response.ok) {
    await discard(response);
    throw new ResearchError(ErrorCodes.HttpError, `HTTP ${response.status}`);
  }

  const contentType = mediaType(response.headers.get("content-type"));
  if (contentType === undefined || !HTML_MEDIA_TYPES.has(contentType)) {
    await discard(response);
    throw new ResearchError(
      ErrorCodes.UnsupportedContentType,
      `Unsupported content type ${contentType ?? "unknown"}`,
    );
  }

  const declared = contentLength(response.headers.get("content-length"));
  if (declared !== undefined && declared > MAX_BYTES) {
    await discard(response);
    throw new ResearchError(ErrorCodes.TooLarge, `Response is larger than ${MAX_BYTES} bytes`);
  }

  return {
    finalUrl: url.href,
    status: response.status,
    contentType,
    body: await readAtMost(response, MAX_BYTES),
  };
}

async function fetchFollowingRedirects(input: string, signal: AbortSignal): Promise<FetchedPage> {
  let current = input;

  for (let followed = 0; ; followed += 1) {
    const url = assertSafeUrl(current);
    await assertPublicHostname(url.hostname);

    const response = await fetch(url, {
      redirect: "manual",
      signal,
      headers: REQUEST_HEADERS,
    });

    if (!isRedirect(response.status)) return readHtml(response, url);

    if (followed >= MAX_REDIRECTS) {
      await discard(response);
      throw new ResearchError(
        ErrorCodes.TooManyRedirects,
        `Stopped after ${MAX_REDIRECTS} redirects`,
      );
    }

    const next = redirectTarget(url, response.headers.get("location"));
    await discard(response);
    current = next;
  }
}

function failureMessage(error: unknown): string {
  if (!(error instanceof Error) || error.message.trim() === "") return "Network request failed";
  const cause = error.cause;
  if (cause instanceof Error && cause.message.trim() !== "") {
    return `${error.message}: ${cause.message}`;
  }
  return error.message;
}

/** Fetch an HTML page after SSRF, size, redirect, content-type, and timeout checks. */
export async function safeFetch(input: string): Promise<FetchedPage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    return await fetchFollowingRedirects(input, controller.signal);
  } catch (error) {
    if (error instanceof ResearchError) throw error;
    if (isAbortError(error)) {
      throw new ResearchError(ErrorCodes.Timeout, "Request timed out after 10 seconds");
    }
    throw new ResearchError(ErrorCodes.FetchFailed, failureMessage(error));
  } finally {
    clearTimeout(timer);
  }
}

/** Backwards-compatible wrapper for callers that only need the HTML body. */
export async function fetchHtml(input: string): Promise<FetchedHtml> {
  const page = await safeFetch(input);
  return { url: page.finalUrl, contentType: page.contentType, body: page.body };
}
