import { createHash } from "node:crypto";

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;
const RESERVED_OR_UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/** Tracking parameters never change the destination page. Everything else is preserved. */
const TRACKING_EXACT = new Set([
  "gclid", "dclid", "fbclid", "msclkid", "yclid", "twclid", "ttclid", "li_fat_id",
  "igshid", "mc_cid", "mc_eid", "_ga", "_gl", "_hsenc", "_hsmi", "hsctatracking",
  "vero_id", "vero_conv", "oly_anon_id", "oly_enc_id", "rb_click_id", "srsltid",
  "gad_source", "gbraid", "wbraid", "_openstat", "mkt_tok", "trk_contact", "trk_module",
]);
const TRACKING_PREFIXES = ["utm_", "pk_", "mtm_", "hsa_"];

export class UrlError extends Error {
  constructor(message, input) {
    super(message);
    this.name = "UrlError";
    this.input = input;
  }
}

export function isTrackingParam(name) {
  const lower = String(name).toLowerCase();
  return TRACKING_EXACT.has(lower) || TRACKING_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export function parseTarget(input, base) {
  if (typeof input !== "string") throw new UrlError(`Invalid URL: ${String(input)}`, input);
  const value = input.trim();
  if (!value) throw new UrlError("Invalid URL: empty", input);
  let url;
  try {
    url = base ? new URL(value, base) : new URL(value);
  } catch {
    throw new UrlError(`Invalid URL: ${value}`, input);
  }
  if (!HTTP_PROTOCOLS.has(url.protocol)) throw new UrlError(`Unsupported URL scheme: ${url.protocol}`, input);
  return url;
}

/** Uppercase percent escapes and decode only RFC 3986 unreserved characters. */
function normalizePercentEncoding(value) {
  return value.replace(/%([0-9a-fA-F]{2})/g, (match, hex) => {
    const character = String.fromCharCode(Number.parseInt(hex, 16));
    return RESERVED_OR_UNRESERVED.test(character) ? character : `%${hex.toUpperCase()}`;
  });
}

export function normalizePathname(pathname = "/") {
  if (!pathname) return "/";
  const encoded = normalizePercentEncoding(pathname);
  const segments = [];
  for (const segment of encoded.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}` || "/";
}

function canonicalSearch(searchParams) {
  const entries = [...searchParams]
    .filter(([name]) => !isTrackingParam(name))
    .sort(([leftName, leftValue], [rightName, rightValue]) => {
      if (leftName !== rightName) return leftName < rightName ? -1 : 1;
      if (leftValue !== rightValue) return leftValue < rightValue ? -1 : 1;
      return 0;
    });
  const output = new URLSearchParams();
  for (const [name, value] of entries) output.append(name, value);
  const serialized = output.toString();
  return serialized ? `?${serialized}` : "";
}

export function normalizeUrl(input, base) {
  const url = parseTarget(input, base);
  return `${url.origin.toLowerCase()}${normalizePathname(url.pathname)}${canonicalSearch(url.searchParams)}`;
}

export const canonicalKey = normalizeUrl;

/**
 * Resolve an anchor target for discovery. Returns null for fragments, non-http
 * schemes, empty values, and malformed URLs instead of inventing a route.
 */
export function resolveDiscoveredLink(href, base) {
  if (typeof href !== "string") return null;
  const value = href.trim();
  if (!value || value.startsWith("#")) return null;
  if (SCHEME_PATTERN.test(value) && !/^https?:/i.test(value) && !value.startsWith("//")) return null;
  try {
    return normalizeUrl(value, base);
  } catch {
    return null;
  }
}

export function isSameOrigin(left, right) {
  try {
    return parseTarget(left).origin.toLowerCase() === parseTarget(right).origin.toLowerCase();
  } catch {
    return false;
  }
}

export function classifyRoute(input) {
  const url = parseTarget(input);
  if (url.pathname === "/" && !url.search) return "home";
  if (url.search) {
    const params = new URLSearchParams(url.search);
    for (const name of ["page", "p", "offset", "start", "pg"]) {
      if (params.has(name) && /^\d+$/.test(params.get(name) ?? "")) return "pagination";
    }
    return "query";
  }
  return normalizePathname(url.pathname).split("/").filter(Boolean).length > 1 ? "nested" : "page";
}

function safePathSegment(value) {
  const decoded = (() => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  })();
  return decoded.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "route";
}

/** Stable, filesystem-safe artifact name for a route. Query routes get a content hash. */
export function routeSlug(input) {
  const url = parseTarget(input);
  const path = normalizePathname(url.pathname);
  const pathSlug = path === "/" ? "index" : path.slice(1).split("/").map(safePathSegment).join("/");
  if (!url.search) return pathSlug;
  const hash = createHash("sha1").update(canonicalSearch(url.searchParams)).digest("hex").slice(0, 8);
  return `${pathSlug.replace(/\//g, "-")}__${hash}`;
}

export function localRouteFor(input) {
  const url = parseTarget(input);
  return `${normalizePathname(url.pathname)}${canonicalSearch(url.searchParams)}`;
}

export function globToRegExp(pattern) {
  const value = String(pattern);
  // "/admin/**" also covers "/admin" itself, which is how scope excludes are read.
  const includesBase = value.endsWith("/**");
  const working = includesBase ? value.slice(0, -3) : value;
  const escaped = working.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const source = escaped
    .split("**")
    .map((part) => part.split("*").join("[^/]*"))
    .join(".*");
  return new RegExp(`^${source}${includesBase ? "(?:/.*)?" : ""}$`);
}

function scopeTargets(candidate) {
  try {
    const url = parseTarget(candidate);
    return {
      full: `${url.origin}${normalizePathname(url.pathname)}${canonicalSearch(url.searchParams)}`,
      path: `${normalizePathname(url.pathname)}${canonicalSearch(url.searchParams)}`,
    };
  } catch {
    const path = candidate.startsWith("/") ? candidate : `/${candidate}`;
    return { full: path, path };
  }
}

export function matchesScope(candidate, { include = [], exclude = [] } = {}) {
  const targets = scopeTargets(candidate);
  const matchesAny = (patterns) => patterns.some((pattern) => {
    const patternText = String(pattern);
    const regex = globToRegExp(patternText);
    return regex.test(targets.path) || regex.test(targets.full);
  });
  if (exclude.length && matchesAny(exclude)) return false;
  if (!include.length) return true;
  return matchesAny(include);
}

function mergeUnique(target, values) {
  const next = new Set(target || []);
  for (const value of values || []) if (value !== undefined && value !== null) next.add(value);
  return [...next];
}

/**
 * Reconcile route records from multiple discovery sources. Returns merged
 * routes plus the duplicate groups that were collapsed.
 */
export function createRouteIndex(routes = []) {
  const byKey = new Map();
  const duplicates = [];
  for (const route of routes) {
    let key;
    try {
      key = canonicalKey(route.canonicalUrl || route.sourceUrl || route.url);
    } catch {
      continue;
    }
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        ...route,
        canonicalUrl: key,
        discoverySources: [...new Set(route.discoverySources || [route.discoverySource || "html"])],
        parentRoutes: [...new Set(route.parentRoutes || [])],
        outboundLinks: [...new Set(route.outboundLinks || [])],
        inboundLinks: [...new Set(route.inboundLinks || [])],
      });
      continue;
    }
    existing.discoverySources = mergeUnique(existing.discoverySources, route.discoverySources || [route.discoverySource]);
    existing.parentRoutes = mergeUnique(existing.parentRoutes, route.parentRoutes);
    existing.outboundLinks = mergeUnique(existing.outboundLinks, route.outboundLinks);
    existing.inboundLinks = mergeUnique(existing.inboundLinks, route.inboundLinks);
    if (!existing.title && route.title) existing.title = route.title;
    const group = duplicates.find((entry) => entry.key === key);
    if (group) group.count += 1;
    else duplicates.push({ key, count: 2 });
  }
  return { routes: [...byKey.values()], byKey, duplicates };
}

/**
 * Rewrite same-origin anchors to local clone routes. Deliberately limited to
 * href/src/action attributes; it never executes or interprets page scripts.
 */
export function rewriteHtmlLinks(html, { sourceOrigin, routes = [], attributeNames = ["href", "src", "action"] } = {}) {
  const map = new Map();
  for (const route of routes) {
    try {
      map.set(canonicalKey(route.canonicalUrl || route.sourceUrl), route.localRoute || localRouteFor(route.canonicalUrl || route.sourceUrl));
    } catch {
      // Ignore malformed route records instead of rewriting to a guessed destination.
    }
  }
  const unresolved = new Set();
  const rewritten = [];
  const attributes = new Set(attributeNames.map((name) => name.toLowerCase()));
  const pattern = /(\s([a-zA-Z][a-zA-Z0-9:-]*)\s*=\s*)(["'])([\s\S]*?)\3/g;
  const output = String(html).replace(pattern, (match, prefix, attribute, quote, value) => {
    if (!attributes.has(attribute.toLowerCase())) return match;
    let resolved;
    try {
      resolved = normalizeUrl(value, sourceOrigin);
    } catch {
      return match;
    }
    if (!isSameOrigin(resolved, sourceOrigin)) return match;
    if (!map.has(resolved)) {
      unresolved.add(resolved);
      return match;
    }
    const localRoute = map.get(resolved);
    rewritten.push({ from: resolved, to: localRoute, attribute: attribute.toLowerCase() });
    return `${prefix}${quote}${localRoute}${quote}`;
  });
  return { html: output, rewritten, unresolved: [...unresolved] };
}
