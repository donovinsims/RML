import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadBrowser, stablePage, stabilize, writeJson } from "./core.mjs";
import { createFetcher, fetchOptionalText } from "./fetch.mjs";
import { buildSiteGraph } from "./graph.mjs";
import { collectSitemapUrls, defaultSitemapCandidates } from "./sitemap.mjs";
import { crawlDelayFrom, parseRobots, robotsAllows } from "./robots.mjs";
import {
  canonicalKey,
  classifyRoute,
  isSameOrigin,
  localRouteFor,
  matchesScope,
  normalizeUrl,
  parseTarget,
  resolveDiscoveredLink,
} from "./url.mjs";
import { loadConfig } from "./config.mjs";

const HISTORY_HOOK = () => {
  if (window.__ppHistory) return;
  window.__ppHistory = [];
  const routeOf = (value) => {
    const target = new URL(value || location.href, location.href);
    return `${target.origin}${target.pathname}${target.search}`;
  };
  let lastRoute = routeOf(location.href);
  const record = (type, url) => {
    try {
      const target = new URL(url || location.href, location.href);
      const nextRoute = routeOf(target.href);
      // Hydration often calls replaceState with the current URL. Only a real
      // path/search change is a client-side route observation; hash-only
      // changes are not routes and must not relabel server-rendered pages.
      if (nextRoute === lastRoute) return;
      lastRoute = nextRoute;
      window.__ppHistory.push({ type, url: target.href, at: Date.now() });
    } catch {
      // Ignore malformed history entries rather than fabricate a route.
    }
  };
  const pushState = history.pushState.bind(history);
  history.pushState = function pushWithObservation(...args) {
    const result = pushState(...args);
    record("pushState", args[2]);
    return result;
  };
  const replaceState = history.replaceState.bind(history);
  history.replaceState = function replaceWithObservation(...args) {
    const result = replaceState(...args);
    record("replaceState", args[2]);
    return result;
  };
  addEventListener("popstate", () => record("popstate", location.href));
  addEventListener("hashchange", () => record("hashchange", location.href));
};

const SAFETY_HOOK = () => {
  addEventListener("submit", (event) => event.preventDefault(), true);
  HTMLFormElement.prototype.submit = function blockedSubmit() {};
  window.open = () => null;
};

function pageEvidence() {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  const regionOf = (element) => {
    const container = element.closest('header, [role="banner"], footer, [role="contentinfo"], aside, [role="complementary"], nav, [role="navigation"], [role="dialog"], main, [role="main"]');
    if (!container) return "body";
    const tag = container.tagName.toLowerCase();
    if (tag === "header") return "header";
    if (tag === "footer") return "footer";
    if (tag === "aside") return "sidebar";
    if (tag === "nav") return "nav";
    if (tag === "main") return "main";
    return container.getAttribute("role") === "dialog" ? "dialog" : "nav";
  };
  const inDropdown = (element) => Boolean(element.closest('[role="menu"], .dropdown, [aria-haspopup="true"], details, [role="dialog"]'));
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const links = [...document.querySelectorAll("a[href], area[href]")].map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      rawHref: element.getAttribute("href"),
      label: clean(element.innerText || element.textContent || element.getAttribute("aria-label") || element.getAttribute("title")).slice(0, 120),
      region: regionOf(element),
      inDropdown: inDropdown(element),
      visible: visible(element),
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      rel: element.getAttribute("rel"),
      target: element.getAttribute("target"),
    };
  });
  const main = document.querySelector('main, [role="main"]') || document.body;
  const headings = [...document.querySelectorAll("h1,h2,h3")]
    .map((element) => ({ level: Number(element.tagName[1]), text: clean(element.textContent) }))
    .filter((entry) => entry.text);
  return {
    title: clean(document.title),
    lang: document.documentElement.lang || null,
    canonical: document.querySelector('link[rel="canonical"]')?.href || null,
    robotsMeta: document.querySelector('meta[name="robots"]')?.content || null,
    headings,
    textSample: clean(main?.innerText).slice(0, 8000),
    bodyText: clean(document.body?.innerText).slice(0, 12000),
    links,
    formCount: document.querySelectorAll("form").length,
    interactiveCount: document.querySelectorAll('a[href], button, input, select, textarea, [role="tab"], summary').length,
    hasDialog: Boolean(document.querySelector("dialog")),
    hasDetails: Boolean(document.querySelector("details")),
  };
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function fingerprint(evidence) {
  const material = [
    evidence.title,
    ...evidence.headings.map((entry) => `${entry.level}:${entry.text}`),
    normalizeWhitespace(evidence.textSample),
  ].join("\n");
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

function detectSoft404(status, evidence) {
  if (status && status >= 400) {
    return {
      type: status === 404 ? "http-404" : "http-error",
      httpStatus: status,
      message: `The source returned HTTP ${status}.`,
    };
  }
  const signal = `${evidence.title} ${evidence.headings.map((entry) => entry.text).join(" ")}`.toLowerCase();
  if (/(^|\b)(404|page not found|not found)(\b|$)/.test(signal) && normalizeWhitespace(evidence.textSample).length < 700) {
    return {
      type: "soft-404",
      httpStatus: status,
      confidence: "heuristic",
      message: "Served with a success status but the title/headings and short content resemble a not-found page.",
    };
  }
  return null;
}

function resolveLinks(evidence, baseUrl, origin, maxLinks) {
  const internal = new Map();
  const external = new Map();
  for (const link of evidence.links.slice(0, maxLinks)) {
    const resolved = resolveDiscoveredLink(link.rawHref, baseUrl);
    if (!resolved) continue;
    if (!isSameOrigin(resolved, origin)) {
      if (!external.has(resolved)) external.set(resolved, { url: resolved, label: link.label });
      continue;
    }
    const existing = internal.get(resolved);
    if (existing) {
      existing.regions.add(link.region);
      existing.visible ||= link.visible;
      existing.inDropdown ||= link.inDropdown;
      if (!existing.label && link.label) existing.label = link.label;
      continue;
    }
    internal.set(resolved, {
      url: resolved,
      label: link.label,
      region: link.region,
      regions: new Set([link.region]),
      visible: link.visible,
      inDropdown: link.inDropdown,
      rel: link.rel,
      target: link.target,
    });
  }
  return { internal: [...internal.values()], external: [...external.values()] };
}

function redirectChainFor(response) {
  const chain = [];
  let request = response?.request();
  const seen = new Set();
  while (request) {
    const url = request.url();
    if (seen.has(url)) break;
    seen.add(url);
    chain.unshift(url);
    request = request.redirectedFrom();
  }
  return chain;
}

async function revealNavigation(page, { maxInteractions = 8, label = "discovery" } = {}) {
  const selector = 'button, summary, [role="tab"], [role="button"], [data-nav]';
  const deny = /\b(delete|remove|purchase|buy|checkout|pay|submit|send|subscribe|confirm|login|log in|sign in|sign out|logout|upgrade|reset|unsubscribe|download|share|book|order|cancel)\b/i;
  const handles = await page.$$(selector);
  const interactions = [];
  let navigatedFully = false;
  for (const handle of handles) {
    if (interactions.length >= maxInteractions) break;
    let info;
    try {
      info = await handle.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          tag: element.tagName.toLowerCase(),
          label: String(element.innerText || element.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 120),
          id: element.id || null,
          ariaControls: element.getAttribute("aria-controls"),
          ariaExpanded: element.getAttribute("aria-expanded"),
          dataNav: element.getAttribute("data-nav"),
          visible: rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden",
          inForm: Boolean(element.closest("form")),
          type: element.getAttribute("type"),
          hasHref: element.hasAttribute("href"),
          disabled: Boolean(element.disabled),
        };
      });
    } catch {
      continue;
    }
    const isCandidate = info.tag === "summary" || info.ariaExpanded !== null || Boolean(info.ariaControls) || Boolean(info.dataNav);
    if (!isCandidate || !info.visible || info.inForm || info.type === "submit" || info.hasHref || info.disabled || deny.test(info.label)) continue;
    const beforeUrl = page.url();
    const beforeHistory = await page.evaluate(() => window.__ppHistory?.length || 0).catch(() => 0);
    try {
      await handle.evaluate((element) => element.click());
    } catch {
      continue;
    }
    await page.waitForTimeout(150).catch(() => {});
    let afterUrl = beforeUrl;
    let history = [];
    try {
      afterUrl = page.url();
      const observed = await page.evaluate(() => window.__ppHistory || []);
      history = [...new Set(observed.slice(beforeHistory).map((entry) => entry.url))];
    } catch {
      navigatedFully = true;
    }
    interactions.push({
      control: {
        tag: info.tag,
        label: info.label,
        id: info.id,
        ariaControls: info.ariaControls,
        ariaExpandedBefore: info.ariaExpanded,
        dataNav: info.dataNav,
      },
      beforeUrl,
      afterUrl,
      observedRoutes: history,
      note: `${label}: bounded side-effect-free disclosure interaction`,
    });
    if (afterUrl !== beforeUrl && !history.length) {
      navigatedFully = true;
      break;
    }
  }
  return { interactions, navigatedFully };
}

function staticEvidence(html, baseUrl) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() || "";
  const canonical = html.match(/<link[^>]+rel=["']?canonical["']?[^>]*href=["']([^"']+)["']/i)?.[1] || null;
  const links = [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map((match) => ({
    rawHref: match[1],
    label: match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120),
    region: "html",
    inDropdown: false,
    visible: true,
    rect: null,
  }));
  const headings = [...html.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi)].map((match) => ({
    level: Number(match[1]),
    text: match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
  }));
  const textSample = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 8000);
  return {
    title,
    lang: html.match(/<html[^>]*lang=["']([^"']+)["']/i)?.[1] || null,
    canonical: canonical ? new URL(canonical, baseUrl).href : null,
    robotsMeta: html.match(/<meta[^>]+name=["']robots["'][^>]*content=["']([^"']+)["']/i)?.[1] || null,
    headings,
    textSample,
    bodyText: textSample,
    links,
    formCount: (html.match(/<form\b/gi) || []).length,
    interactiveCount: (html.match(/<(a|button|input|select|textarea|summary)\b/gi) || []).length,
    hasDialog: /<dialog\b/i.test(html),
    hasDetails: /<details\b/i.test(html),
  };
}

function coverageConfidence(sources, error) {
  if (error) return "none";
  const set = new Set(sources);
  if (set.has("sitemap") && set.has("html")) return "high";
  if (set.has("html") || set.has("nav")) return "high";
  if (set.has("sitemap") || set.has("spa-history")) return "medium";
  return "medium";
}

export function mergeManifest(previous, next) {
  if (!previous?.routes?.length) return next;
  const merged = JSON.parse(JSON.stringify(next));
  const previousRoutes = new Map(previous.routes.map((route) => [route.canonicalUrl, route]));
  let stale = 0;
  let retained = 0;
  for (const route of merged.routes) {
    const old = previousRoutes.get(route.canonicalUrl);
    if (!old) continue;
    previousRoutes.delete(route.canonicalUrl);
    const fingerprintChanged = Boolean(old.contentFingerprint && route.contentFingerprint && old.contentFingerprint !== route.contentFingerprint);
    if (fingerprintChanged) {
      stale += 1;
      route.captureStatus = old.captureStatus && old.captureStatus !== "pending" ? "stale" : "pending";
      route.implementationStatus = old.implementationStatus || "pending";
      route.verificationStatus = old.verificationStatus && old.verificationStatus !== "unverified" ? "stale" : "unverified";
      route.previousContentFingerprint = old.contentFingerprint;
      route.coverageNotes = [...new Set([...(route.coverageNotes || []), "source content changed since the last capture"])];
    } else {
      route.captureStatus = old.captureStatus || route.captureStatus;
      route.implementationStatus = old.implementationStatus || route.implementationStatus;
      route.verificationStatus = old.verificationStatus || route.verificationStatus;
      route.capturedFingerprint = old.capturedFingerprint || null;
      route.evidenceDir = old.evidenceDir || null;
      route.blockers = [...new Set([...(old.blockers || []), ...(route.blockers || [])])];
    }
  }
  for (const old of previousRoutes.values()) {
    retained += 1;
    merged.routes.push({
      ...old,
      discoveryStatus: "missing-in-latest",
      retainedFromPrevious: true,
      coverageNotes: [...new Set([...(old.coverageNotes || []), "route was present in an earlier manifest but not discovered in this run"])],
      verificationStatus: old.verificationStatus === "verified" ? "stale" : old.verificationStatus,
    });
  }
  merged.summary = {
    ...merged.summary,
    discovered: merged.routes.length,
    retained,
    stale,
  };
  return merged;
}

function renderReport(manifest, graph) {
  const rows = manifest.routes.map((route) =>
    `| ${route.localRoute} | ${route.title || "-"} | ${route.routeType} | ${route.discoverySources.join(", ")} | ${route.discoveryStatus} | ${route.httpStatus ?? "-"} |`,
  );
  const excluded = manifest.excluded.map((entry) => `| ${entry.localRoute} | ${entry.reason} | ${entry.detail || "-"} |`);
  return `# Discovery report

- Source: ${manifest.site.sourceUrl}
- Generated: ${manifest.site.discoveredAt}
- Discovered routes: **${manifest.summary.discovered}**
- Selected routes: **${manifest.summary.selected}**
- Failed routes: **${manifest.summary.failed}**
- Excluded routes: **${manifest.summary.excluded}**
- Redirect aliases: **${manifest.summary.redirects}**
- Unresolved links: **${manifest.summary.unresolvedLinks}**
- Truncated: **${manifest.summary.truncated ? "yes" : "no"}**
- Limits hit: ${manifest.summary.limitsHit.length ? manifest.summary.limitsHit.join(", ") : "none"}

## Route inventory

| Local route | Title | Type | Sources | Discovery | HTTP |
| --- | --- | --- | --- | --- | ---: |
${rows.join("\n") || "| - | - | - | - | - | - |"}

## Excluded routes

| Local route | Reason | Detail |
| --- | --- | --- |
${excluded.join("\n") || "| - | - | - |"}

## Redirects and canonical aliases

${manifest.redirects.length ? manifest.redirects.map((entry) => `- \`${entry.localRoute}\` -> \`${entry.canonicalRoute}\` (${entry.reason})`).join("\n") : "None observed."}

## Site graph

- Shared header links: ${graph.sharedLayout.header.map((href) => `\`${href}\``).join(", ") || "none"}
- Shared footer links: ${graph.sharedLayout.footer.map((href) => `\`${href}\``).join(", ") || "none"}
- Dropdown links: ${graph.sharedLayout.dropdowns.map((href) => `\`${href}\``).join(", ") || "none"}
- Orphans: ${graph.orphans.map((href) => `\`${href}\``).join(", ") || "none"}
- Unreachable from home: ${graph.unreachable.map((href) => `\`${href}\``).join(", ") || "none"}

## Evidence boundaries

- ${manifest.summary.truncated ? "Discovery stopped at a configured limit; this inventory is not exhaustive." : "No configured discovery limit stopped the crawl."}
- Pages that returned errors are listed as failed and are not selected for reconstruction.
- Excluded and unresolved destinations are reported rather than redirected to the homepage.
- Discovery is rerunnable; the route manifest preserves capture and verification status when content fingerprints are unchanged.
`;
}

const consoleLogger = {
  info(message) {
    process.stderr.write(`[discover] ${message}\n`);
  },
  warn(message) {
    process.stderr.write(`[discover] warning: ${message}\n`);
  },
  error(message) {
    process.stderr.write(`[discover] error: ${message}\n`);
  },
};

/**
 * Discover the authorized, in-scope route inventory for one origin. This is a
 * bounded crawl: robots policy, configured patterns, depth, page count, query
 * variants, pagination, duration, and interaction count are all enforced.
 */
export async function discoverSite({ url, out, config: configInput = {}, browser = null, logger = consoleLogger }) {
  const startedAt = Date.now();
  const base = parseTarget(url);
  const config = await loadConfig({ overrides: configInput });
  const settings = config.discovery;
  const evidenceDir = join(out, "evidence");
  await mkdir(evidenceDir, { recursive: true });

  const ownBrowser = !browser && settings.render;
  const activeBrowser = browser || (ownBrowser ? await loadBrowser() : null);
  const fetcher = createFetcher({
    timeoutMs: settings.timeoutMs,
    retries: settings.retries,
    delayMs: settings.requestDelayMs,
    userAgent: settings.userAgent,
  });

  const routes = new Map();
  const excluded = new Map();
  const redirects = new Map();
  const unresolved = new Map();
  const queue = [];
  const queued = new Set();
  const limitsHit = new Set();
  const navigationByRoute = new Map();
  let attempted = 0;
  let truncated = false;
  let stop = false;

  const normalizeSafe = (value) => {
    try {
      return normalizeUrl(value, base.href);
    } catch {
      return null;
    }
  };

  const recordExcluded = (value, reason, detail = null, source = "html") => {
    const key = normalizeSafe(value);
    if (!key) return;
    const existing = excluded.get(key);
    if (existing) {
      if (!existing.discoverySources.includes(source)) existing.discoverySources.push(source);
      return;
    }
    excluded.set(key, {
      sourceUrl: key,
      canonicalUrl: key,
      localRoute: localRouteFor(key),
      reason,
      detail,
      discoverySources: [source],
      selected: false,
    });
  };

  const recordUnresolved = (value, reason, foundOn) => {
    const key = normalizeSafe(value);
    if (!key) return;
    const existing = unresolved.get(key);
    if (existing) {
      if (foundOn && !existing.foundOn.includes(foundOn)) existing.foundOn.push(foundOn);
      if (reason === "not-crawled" && existing.reason !== "not-crawled") existing.reason = reason;
      return;
    }
    unresolved.set(key, { url: key, localRoute: localRouteFor(key), reason, foundOn: foundOn ? [foundOn] : [] });
  };

  const enqueue = (value, { depth, parent = null, sources = ["html"], explicit = false }) => {
    if (stop) return;
    const key = normalizeSafe(value);
    if (!key) {
      recordUnresolved(value, "invalid-url", parent);
      return;
    }
    if (routes.has(key) || queued.has(key) || redirects.has(key) || excluded.has(key)) return;
    if (!isSameOrigin(key, base.origin)) return;
    if (!explicit && !matchesScope(key, { include: settings.include, exclude: settings.exclude })) {
      recordExcluded(key, "out-of-scope", "did not match discovery.include/exclude", sources[0]);
      return;
    }
    const target = parseTarget(key);
    if (settings.respectRobots && !robotsAllows(`${target.pathname}${target.search}`, robots, { userAgent: settings.userAgent })) {
      recordExcluded(key, "robots-disallowed", "blocked by robots.txt", sources[0]);
      return;
    }
    if (depth > settings.maxDepth) {
      limitsHit.add("maxDepth");
      truncated = true;
      recordUnresolved(key, "depth-limit", parent);
      return;
    }
    if (target.search) {
      const parameterCount = [...target.searchParams.keys()].length;
      if (parameterCount > 12) {
        recordExcluded(key, "query-parameter-trap", `${parameterCount} query parameters on one route`, sources[0]);
        return;
      }
      const samePathVariants = new Set(
        [...routes.keys(), ...queued]
          .filter((candidate) => {
            try {
              const parsed = parseTarget(candidate);
              return parsed.pathname === target.pathname && parsed.search;
            } catch {
              return false;
            }
          }),
      ).size;
      if (samePathVariants >= settings.maxQueryVariants) {
        recordExcluded(key, "query-variant-limit", `${samePathVariants} query variants already queued`, sources[0]);
        return;
      }
      const routeType = classifyRoute(key);
      if (routeType === "pagination") {
        const samePath = [...routes.keys()].filter((candidate) => {
          try {
            return parseTarget(candidate).pathname === target.pathname;
          } catch {
            return false;
          }
        });
        if (samePath.length >= settings.pagination.maxPages) {
          recordExcluded(key, "pagination-limit", `${samePath.length} pages already discovered for ${target.pathname}`, sources[0]);
          return;
        }
      }
    }
    queued.add(key);
    queue.push({ url: key, depth, parent, sources: [...new Set(sources)] });
  };

  logger.info(`robots.txt: ${base.origin}/robots.txt`);
  const robotsResult = await fetchOptionalText(fetcher, `${base.origin}/robots.txt`, { maxBytes: 512_000 });
  const robots = parseRobots(robotsResult.text || "");
  const robotsInfo = {
    url: `${base.origin}/robots.txt`,
    available: robotsResult.available,
    status: robotsResult.status,
    error: robotsResult.error || null,
    groupCount: robots.groups.length,
    crawlDelay: crawlDelayFrom(robots, { userAgent: settings.userAgent }),
    declaredSitemaps: robots.sitemaps,
    respectRobots: settings.respectRobots,
  };

  const sitemapSeeds = robots.sitemaps.length ? robots.sitemaps : defaultSitemapCandidates(base.origin);
  logger.info(`collecting ${sitemapSeeds.length} sitemap seed(s)`);
  const sitemapResult = await collectSitemapUrls({
    sitemapUrls: sitemapSeeds,
    maxSitemaps: settings.maxSitemaps,
    fetchText: (sitemapUrl) => fetcher.text(sitemapUrl, { maxBytes: 5_000_000 }),
  });
  if (sitemapResult.truncated) limitsHit.add("maxSitemaps");

  enqueue(base.href, { depth: 0, sources: ["start"], explicit: true });
  for (const entry of sitemapResult.urls) {
    enqueue(entry.url, { depth: 0, sources: ["sitemap"] });
  }

  async function processTask(task) {
    if (!settings.render || !activeBrowser) {
      const response = await fetcher.request(task.url);
      const finalUrl = normalizeSafe(response.finalUrl) || task.url;
      const evidence = staticEvidence(response.body.toString("utf8"), finalUrl);
      const error = detectSoft404(response.status, evidence);
      return {
        task,
        evidence,
        finalUrl,
        status: response.status,
        redirectChain: finalUrl !== task.url ? [task.url, finalUrl] : [],
        interactions: [],
        historyRoutes: [],
        external: resolveLinks(evidence, finalUrl, base.origin, settings.maxLinksPerPage).external,
        resolvedLinks: resolveLinks(evidence, finalUrl, base.origin, settings.maxLinksPerPage).internal,
        coverageNotes: ["static-html-mode: hidden navigation and SPA history are unavailable"],
        blockers: [],
        error,
        navigatedFully: false,
        stabilization: null,
      };
    }

    const { context, page } = await stablePage(activeBrowser, { width: 1280, height: 900 }, { userAgent: settings.userAgent });
    let mainResponse = null;
    page.on("response", (response) => {
      if (!mainResponse && response.request().isNavigationRequest() && response.frame() === page.mainFrame()) mainResponse = response;
    });
    page.on("dialog", (dialog) => dialog.dismiss().catch(() => {}));
    try {
      await context.addInitScript(HISTORY_HOOK);
      await context.addInitScript(SAFETY_HOOK);
      const stabilization = await stabilize(page, task.url, { timeoutMs: settings.timeoutMs, scroll: false });
      const loadedUrl = normalizeSafe(page.url()) || task.url;
      let evidence;
      try {
        evidence = await page.evaluate(pageEvidence);
      } catch (error) {
        return {
          task,
          evidence: null,
          finalUrl: loadedUrl,
          status: mainResponse?.status() ?? null,
          redirectChain: redirectChainFor(mainResponse),
          interactions: [],
          historyRoutes: [],
          external: [],
          resolvedLinks: [],
          coverageNotes: [],
          blockers: ["page evidence unavailable"],
          error: {
            type: stabilization.navigationError ? "navigation-error" : "evidence-unavailable",
            httpStatus: mainResponse?.status() ?? null,
            message: stabilization.navigationError || error.message.split("\n")[0],
          },
          navigatedFully: false,
          stabilization,
        };
      }
      const reveal = settings.revealNavigation
        ? await revealNavigation(page, { maxInteractions: settings.maxNavigationInteractions })
        : { interactions: [], navigatedFully: false };
      let history = [];
      try {
        history = await page.evaluate(() => window.__ppHistory || []);
      } catch {
        history = [];
      }
      const historyRoutes = [];
      for (const entry of history) {
        const normalized = normalizeSafe(entry.url);
        if (normalized && isSameOrigin(normalized, base.origin)) historyRoutes.push(normalized);
      }
      for (const interaction of reveal.interactions) {
        if (interaction.afterUrl && interaction.afterUrl !== loadedUrl) {
          const normalized = normalizeSafe(interaction.afterUrl);
          if (normalized && isSameOrigin(normalized, base.origin)) historyRoutes.push(normalized);
        }
      }
      const resolvedLinks = resolveLinks(evidence, loadedUrl, base.origin, settings.maxLinksPerPage);
      const status = mainResponse?.status() ?? (stabilization.navigationError ? null : 200);
      const error = detectSoft404(status, evidence);
      const coverageNotes = [];
      if (stabilization.navigationError) coverageNotes.push(`navigation: ${stabilization.navigationError}`);
      if (stabilization.timedOut.length) coverageNotes.push(`stabilization timeouts: ${stabilization.timedOut.join(", ")}`);
      if (reveal.navigatedFully) coverageNotes.push("a disclosure interaction navigated the page; later controls were not inspected");
      if (historyRoutes.length) coverageNotes.push(`${historyRoutes.length} client-side route change(s) observed`);
      return {
        task,
        evidence,
        finalUrl: loadedUrl,
        status,
        redirectChain: redirectChainFor(mainResponse),
        interactions: reveal.interactions,
        historyRoutes: [...new Set(historyRoutes)],
        external: resolvedLinks.external,
        resolvedLinks: resolvedLinks.internal,
        coverageNotes,
        blockers: error?.type === "soft-404" ? ["soft-404 heuristic requires review"] : [],
        error,
        navigatedFully: reveal.navigatedFully,
        stabilization,
      };
    } finally {
      await context.close().catch(() => {});
    }
  }

  try {
    while (queue.length && !stop) {
      const batch = [];
      while (queue.length && batch.length < settings.concurrency) {
        if (attempted >= settings.maxPages) break;
        if (Date.now() - startedAt >= settings.maxDurationMs) break;
        const task = queue.shift();
        if (routes.has(task.url) || redirects.has(task.url)) continue;
        batch.push(task);
        attempted += 1;
      }
      if (!batch.length) {
        if (queue.length) {
          if (attempted >= settings.maxPages) limitsHit.add("maxPages");
          if (Date.now() - startedAt >= settings.maxDurationMs) limitsHit.add("maxDurationMs");
          truncated = true;
          stop = true;
        }
        break;
      }
      logger.info(`capturing ${batch.map((task) => localRouteFor(task.url)).join(", ")}`);
      const results = await Promise.all(batch.map((task) => processTask(task).catch((error) => ({
        task,
        evidence: null,
        finalUrl: task.url,
        status: null,
        redirectChain: [],
        interactions: [],
        historyRoutes: [],
        external: [],
        resolvedLinks: [],
        coverageNotes: [],
        blockers: ["capture failed"],
        error: { type: "capture-error", message: error.message.split("\n")[0] },
        navigatedFully: false,
      }))));

      for (const result of results) {
        const { task, evidence } = result;
        const finalKey = normalizeSafe(result.finalUrl) || task.url;
        let canonicalTarget = finalKey;
        if (evidence?.canonical) {
          const canonicalKeyValue = normalizeSafe(evidence.canonical);
          if (canonicalKeyValue && isSameOrigin(canonicalKeyValue, base.origin) && matchesScope(canonicalKeyValue, { include: settings.include, exclude: settings.exclude })) {
            canonicalTarget = canonicalKeyValue;
          }
        }

        const redirectNeeded = canonicalTarget !== task.url;
        if (redirectNeeded) {
          redirects.set(task.url, {
            sourceUrl: task.url,
            canonicalUrl: canonicalTarget,
            localRoute: localRouteFor(task.url),
            canonicalRoute: localRouteFor(canonicalTarget),
            reason: result.redirectChain.length > 1 ? "redirect" : "canonical",
            chain: result.redirectChain.length > 1 ? [...new Set([task.url, ...result.redirectChain, finalKey])] : [task.url, canonicalTarget],
            httpStatus: result.status,
            discoveryStatus: "redirected",
          });
        }
        if (!evidence) {
          const record = {
            sourceUrl: task.url,
            canonicalUrl: canonicalTarget,
            localRoute: localRouteFor(canonicalTarget),
            title: "",
            routeType: classifyRoute(canonicalTarget),
            discoverySources: [...new Set(task.sources)],
            depth: task.depth,
            parentRoutes: task.parent ? [task.parent] : [],
            childRoutes: [],
            inboundLinks: [],
            outboundLinks: [],
            navigation: [],
            discoveryStatus: "failed",
            captureStatus: "pending",
            implementationStatus: "pending",
            verificationStatus: "unverified",
            httpStatus: result.status,
            redirect: null,
            error: result.error,
            contentFingerprint: null,
            interactiveStates: [],
            confidence: "none",
            coverageNotes: result.coverageNotes,
            blockers: result.blockers,
            evidenceDir: null,
          };
          if (!routes.has(record.canonicalUrl)) routes.set(record.canonicalUrl, record);
          continue;
        }

        const spaSet = new Set(result.historyRoutes);
        const sources = [...new Set([...task.sources, ...(spaSet.has(canonicalTarget) ? ["spa-history"] : [])])];
        const navigation = result.resolvedLinks
          .filter((link) => ["header", "nav", "footer", "sidebar"].includes(link.region) || link.inDropdown)
          .map((link) => ({
            href: localRouteFor(link.url),
            url: link.url,
            label: link.label,
            region: link.inDropdown ? "dropdown" : link.region,
            inDropdown: link.inDropdown,
            visible: link.visible,
          }));
        const outboundLinks = [...new Set(result.resolvedLinks.map((link) => link.url))];
        const record = {
          sourceUrl: task.url,
          canonicalUrl: canonicalTarget,
          localRoute: localRouteFor(canonicalTarget),
          title: evidence.title,
          // A route is SPA-only when history is its only discovery source. A
          // server-rendered page that also has client navigation keeps its
          // structural type while retaining spa-history in discoverySources.
          routeType: sources.every((source) => source === "spa-history") ? "spa" : classifyRoute(canonicalTarget),
          discoverySources: sources,
          depth: task.depth,
          parentRoutes: task.parent ? [task.parent] : [],
          childRoutes: [],
          inboundLinks: [],
          outboundLinks,
          navigation,
          discoveryStatus: result.error ? "failed" : "discovered",
          captureStatus: "pending",
          implementationStatus: "pending",
          verificationStatus: "unverified",
          httpStatus: result.status,
          redirect: result.redirectChain.length > 1 ? { chain: [...new Set([task.url, ...result.redirectChain, finalKey])], finalUrl: finalKey } : null,
          error: result.error,
          contentFingerprint: fingerprint(evidence),
          interactiveStates: result.interactions.map((interaction) => ({
            control: interaction.control,
            beforeUrl: interaction.beforeUrl,
            afterUrl: interaction.afterUrl,
            observedRoutes: interaction.observedRoutes,
            note: interaction.note,
          })),
          confidence: coverageConfidence(sources, result.error),
          coverageNotes: result.coverageNotes,
          blockers: result.blockers,
          headings: evidence.headings.map((entry) => entry.text),
          formCount: evidence.formCount,
          mediaNote: null,
          evidenceDir: null,
        };

        const existing = routes.get(record.canonicalUrl);
        if (existing) {
          existing.discoverySources = [...new Set([...existing.discoverySources, ...record.discoverySources])];
          existing.parentRoutes = [...new Set([...existing.parentRoutes, ...record.parentRoutes])];
          existing.outboundLinks = [...new Set([...existing.outboundLinks, ...record.outboundLinks])];
          existing.coverageNotes = [...new Set([...existing.coverageNotes, ...record.coverageNotes])];
        } else {
          routes.set(record.canonicalUrl, record);
        }
        const parentRoute = existing?.localRoute || record.localRoute;
        if (!navigationByRoute.has(parentRoute)) navigationByRoute.set(parentRoute, []);
        navigationByRoute.get(parentRoute).push(...navigation);

        for (const link of result.resolvedLinks) {
          enqueue(link.url, {
            depth: task.depth + 1,
            parent: parentRoute,
            sources: [link.inDropdown ? "dropdown" : "html"],
          });
        }
        for (const spaRoute of spaSet) {
          enqueue(spaRoute, { depth: task.depth + 1, parent: parentRoute, sources: ["spa-history"] });
        }
      }
    }
  } finally {
    if (ownBrowser) await activeBrowser?.close().catch(() => {});
  }

  const routeList = [...routes.values()];
  for (const route of routeList) {
    route.navigation = navigationByRoute.get(route.localRoute) || route.navigation || [];
    if (!route.parentRoutes.length && route.depth === 0 && route.localRoute !== "/") {
      route.parentRoutes = [];
    }
  }
  for (const route of routeList) {
    route.childRoutes = routeList
      .filter((candidate) => candidate.canonicalUrl !== route.canonicalUrl && route.outboundLinks.includes(candidate.canonicalUrl))
      .map((candidate) => candidate.canonicalUrl);
    route.inboundLinks = routeList
      .filter((candidate) => candidate.canonicalUrl !== route.canonicalUrl && candidate.outboundLinks.includes(route.canonicalUrl))
      .map((candidate) => candidate.canonicalUrl);
    route.parentRoutes = [...new Set([...route.parentRoutes, ...route.inboundLinks])];
  }
  for (const route of routeList) {
    for (const url of route.outboundLinks) {
      if (routes.has(url) || redirects.has(url) || excluded.has(url)) continue;
      recordUnresolved(url, "not-crawled", route.localRoute);
    }
  }

  routeList.sort((left, right) => {
    if (left.localRoute === "/") return -1;
    if (right.localRoute === "/") return 1;
    return left.localRoute.localeCompare(right.localRoute);
  });

  const failed = routeList.filter((route) => route.discoveryStatus === "failed").length;
  const summary = {
    discovered: routeList.length,
    selected: routeList.filter((route) => route.discoveryStatus === "discovered").length,
    failed,
    excluded: excluded.size,
    redirects: redirects.size,
    unresolvedLinks: unresolved.size,
    implemented: 0,
    verified: 0,
    pagesFetched: attempted,
    sitemapUrls: sitemapResult.urls.length,
    truncated: truncated || sitemapResult.truncated,
    limitsHit: [...limitsHit].sort(),
    durationMs: Date.now() - startedAt,
  };

  const manifest = {
    version: 1,
    kind: "rml-route-manifest",
    site: {
      sourceUrl: base.href,
      origin: base.origin,
      mode: "exact",
      discoveredAt: new Date().toISOString(),
    },
    config: {
      discovery: settings,
      capture: config.capture,
      verification: config.verification,
    },
    robots: robotsInfo,
    sitemaps: {
      documents: sitemapResult.sitemaps,
      failures: sitemapResult.failures,
      truncated: sitemapResult.truncated,
    },
    routes: routeList,
    excluded: [...excluded.values()].sort((left, right) => left.localRoute.localeCompare(right.localRoute)),
    redirects: [...redirects.values()].sort((left, right) => left.localRoute.localeCompare(right.localRoute)),
    unresolvedLinks: [...unresolved.values()].sort((left, right) => left.localRoute.localeCompare(right.localRoute)),
    summary,
    methodology: [
      "robots.txt policy and sitemap declarations",
      "sitemap urlset and sitemapindex traversal",
      "rendered HTML anchors from header, navigation, dropdowns, footer, sidebar, and content",
      "bounded disclosure interactions for hidden navigation",
      "history.pushState / replaceState / popstate observations",
      "same-origin scope, depth, page, query, pagination, and duration limits",
    ],
  };

  let previous = null;
  try {
    previous = JSON.parse(await readFile(join(evidenceDir, "routes.json"), "utf8"));
  } catch {
    previous = null;
  }
  const merged = mergeManifest(previous, manifest);
  const graph = buildSiteGraph(merged);

  await writeJson(join(evidenceDir, "routes.json"), merged);
  await writeJson(join(evidenceDir, "site-graph.json"), graph);
  await writeFile(join(evidenceDir, "discovery-report.md"), renderReport(merged, graph));

  logger.info(`discovered ${merged.summary.discovered} route(s); selected ${merged.summary.selected}; ${merged.summary.truncated ? "truncated at a limit" : "within limits"}`);
  return merged;
}
