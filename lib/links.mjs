import { localRouteFor } from "./url.mjs";

const SPECIAL_PROTOCOL = /^(?:mailto:|tel:|javascript:|data:|blob:)/i;

function isVisible(entry) {
  return entry.visible !== false;
}

/** Accept absolute inventory URLs and manifest-local routes alike. */
function localOf(value) {
  if (!value) return null;
  try {
    return localRouteFor(value);
  } catch {
    try {
      return localRouteFor(new URL(value, "http://manifest.invalid").href);
    } catch {
      return null;
    }
  }
}

/**
 * Classify rendered anchors. Internal clone links must resolve to a route in
 * the one canonical manifest; source-origin links are escapes, not external
 * links. Known source failures are reported as notes, never silently erased.
 */
export function classifyPageLinks({ links = [], manifest = {}, cloneUrl, sourceOrigin = manifest.site?.origin }) {
  const cloneOrigin = new URL(cloneUrl).origin;
  const routes = manifest.routes || [];
  const byLocal = new Map(routes.map((route) => [localOf(route.canonicalUrl || route.sourceUrl || route.localRoute), route]).filter(([key]) => key));
  const redirects = new Map((manifest.redirects || []).map((entry) => [localOf(entry.localRoute || entry.sourceUrl), entry]).filter(([key]) => key));
  const excluded = new Map((manifest.excluded || []).map((entry) => [localOf(entry.localRoute || entry.sourceUrl), entry]).filter(([key]) => key));
  const unresolved = new Map((manifest.unresolved || []).map((entry) => [localOf(entry.localRoute || entry.url), entry]).filter(([key]) => key));
  const classified = [];

  for (const link of links) {
    const raw = String(link.rawHref || link.href || "").trim();
    const entry = { ...link, rawHref: raw };
    if (!raw) {
      classified.push({ ...entry, kind: "empty" });
      continue;
    }
    if (raw.startsWith("#")) {
      classified.push({ ...entry, kind: "in-page-anchor" });
      continue;
    }
    if (SPECIAL_PROTOCOL.test(raw)) {
      classified.push({ ...entry, kind: "special" });
      continue;
    }

    let target;
    try {
      target = new URL(link.href || raw, cloneUrl);
    } catch {
      classified.push({ ...entry, kind: "malformed" });
      continue;
    }
    if (!/^https?:$/.test(target.protocol)) {
      classified.push({ ...entry, kind: "special" });
      continue;
    }

    if (target.origin === cloneOrigin) {
      const local = localOf(target.href);
      const route = byLocal.get(local);
      if (route) {
        if (route.discoveryStatus === "failed" || Number(route.httpStatus) >= 400) {
          classified.push({ ...entry, kind: "known-failed", localRoute: local, note: "The source inventory records this destination as failed; it is unresolved, not a new clone defect." });
        } else if (route.discoveryStatus === "discovered") {
          classified.push({ ...entry, kind: "internal", localRoute: local });
        } else {
          classified.push({ ...entry, kind: "known-unselected", localRoute: local, note: `Route is known but not selected (${route.discoveryStatus}).` });
        }
      } else if (redirects.has(local)) {
        classified.push({ ...entry, kind: "known-redirect", localRoute: local, canonicalRoute: redirects.get(local).canonicalRoute });
      } else if (excluded.has(local)) {
        classified.push({ ...entry, kind: "known-excluded", localRoute: local, note: `Source policy excluded this destination (${excluded.get(local).reason}).` });
      } else if (unresolved.has(local)) {
        classified.push({ ...entry, kind: "known-unresolved", localRoute: local, note: "The source inventory records this destination as unresolved." });
      } else {
        classified.push({ ...entry, kind: "broken", localRoute: local, note: "No implementation route exists for this internal destination." });
      }
      continue;
    }

    if (sourceOrigin && target.origin === new URL(sourceOrigin).origin) {
      classified.push({ ...entry, kind: "escaped", localRoute: localOf(target.href), note: "Link points back to the authorized source origin instead of the clone." });
      continue;
    }
    classified.push({ ...entry, kind: "external", href: target.href });
  }

  const byKind = (kind) => classified.filter((entry) => entry.kind === kind);
  const failed = byKind("broken").length > 0 || byKind("escaped").length > 0;
  return {
    cloneOrigin,
    sourceOrigin,
    links: classified,
    summary: {
      total: classified.length,
      visible: classified.filter(isVisible).length,
      internal: byKind("internal").length,
      external: byKind("external").length,
      inPageAnchors: byKind("in-page-anchor").length,
      broken: byKind("broken").length,
      escaped: byKind("escaped").length,
      knownFailed: byKind("known-failed").length,
      knownExcluded: byKind("known-excluded").length,
      knownRedirects: byKind("known-redirect").length,
      knownUnselected: byKind("known-unselected").length,
      knownUnresolved: byKind("known-unresolved").length,
      malformed: byKind("malformed").length,
    },
    status: failed ? "fail" : "pass",
    notes: classified.filter((entry) => entry.note).map((entry) => `${entry.kind}: ${entry.note}`),
  };
}

export function pageLinkSnapshot() {
  return [...document.querySelectorAll("a[href]")].map((element, index) => {
    const rect = element.getBoundingClientRect();
    return {
      index,
      rawHref: element.getAttribute("href"),
      href: element.href,
      text: String(element.innerText || element.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 160),
      visible: rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden",
    };
  });
}
